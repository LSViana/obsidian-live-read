import { syntaxTree } from '@codemirror/language';
import {
	EditorSelection,
	EditorState,
	Extension,
	Prec,
	StateEffect,
	StateField,
	type Range as CMRange,
	TransactionSpec,
	findClusterBreak,
} from '@codemirror/state';
import {
	Decoration,
	DecorationSet,
	EditorView,
	ViewPlugin,
	ViewUpdate,
	WidgetType,
	keymap,
} from '@codemirror/view';
import { editorLivePreviewField } from 'obsidian';
import {
	HiddenResult,
	Kind,
	MarkerPair,
	Range,
	Token,
	backspaceRange,
	computeHidden,
	deleteForwardRange,
	insertPosition,
	markerKinds,
	mergeRanges,
	skipBlock,
	skipHiddenEdge,
} from './hidden-ranges';
import {
	type LinkKind,
	type LinkSpan,
	cleanTarget,
	isLinkToken,
	linkAt,
	planLinkEdit,
} from './links';
import { type Block, isBlockToken, parseBlock } from './blocks';
import {
	type Deferred,
	isSpace,
	planDeferredLetter,
	planPendingInput,
	planSpaceInput,
	togglePending,
} from './pending';

const hideMarker = Decoration.replace({});

function isLivePreview(state: EditorState): boolean {
	return state.field(editorLivePreviewField, false) === true;
}

interface LineTokens {
	from: number;
	text: string;
	tokens: Token[];
}

/** Marker, link and block tokens of the visible lines, grouped by line. */
function collectLines(view: EditorView): LineTokens[] {
	const { state } = view;
	const byLine = new Map<number, LineTokens>();
	const tree = syntaxTree(state);
	for (const { from, to } of view.visibleRanges) {
		tree.iterate({
			from,
			to,
			enter: (node) => {
				const name = node.name;
				if (markerKinds(name).length === 0 && !isLinkToken(name) && !isBlockToken(name)) return;
				const line = state.doc.lineAt(node.from);
				let entry = byLine.get(line.number);
				if (!entry) {
					entry = { from: line.from, text: line.text, tokens: [] };
					byLine.set(line.number, entry);
				}
				if (!entry.tokens.some((t) => t.from === node.from && t.to === node.to)) {
					entry.tokens.push({ from: node.from, to: node.to, name });
				}
			},
		});
	}
	return [...byLine.values()];
}

const QUOTE_LINE = /^\s*>/;
const CALLOUT_START = /^\s*>+\s*\[!/;

/** True when the line belongs to a callout (`> [!note]`), left to Obsidian. */
function inCallout(state: EditorState, lineFrom: number, cache: Map<number, boolean>): boolean {
	let line = state.doc.lineAt(lineFrom);
	if (!QUOTE_LINE.test(line.text)) return false;
	// Walk up to the first line of this quote (bounded, for very long quotes).
	for (let i = 0; i < 500 && line.number > 1; i++) {
		const prev = state.doc.line(line.number - 1);
		if (!QUOTE_LINE.test(prev.text)) break;
		line = prev;
	}
	let callout = cache.get(line.number);
	if (callout === undefined) {
		callout = CALLOUT_START.test(line.text);
		cache.set(line.number, callout);
	}
	return callout;
}

class QuoteBorderWidget extends WidgetType {
	eq() {
		return true;
	}
	toDOM() {
		const span = document.createElement('span');
		span.className = 'cm-blockquote-border cm-transparent';
		span.textContent = '>';
		return span;
	}
}

class CheckboxWidget extends WidgetType {
	constructor(readonly task: string) {
		super();
	}
	eq(other: CheckboxWidget) {
		return other.task === this.task;
	}
	toDOM(view: EditorView) {
		// Same markup as Obsidian's checkbox, so themes style it the same.
		const label = document.createElement('label');
		label.className = 'task-list-label';
		const input = document.createElement('input');
		input.type = 'checkbox';
		input.className = 'task-list-item-checkbox';
		input.setAttribute('data-task', this.task);
		input.checked = this.task !== ' ';
		label.appendChild(input);
		label.addEventListener('mousedown', (e) => e.preventDefault());
		input.addEventListener('change', () => toggleTask(view, label, input.checked));
		return label;
	}
}

/** Writes a checkbox click into the text: `[ ]` becomes `[x]` and back. */
function toggleTask(view: EditorView, el: HTMLElement, checked: boolean) {
	let pos: number;
	try {
		pos = view.posAtDOM(el);
	} catch {
		return;
	}
	if (view.state.sliceDoc(pos, pos + 1) !== '[') return;
	view.dispatch({
		changes: { from: pos + 1, to: pos + 2, insert: checked ? 'x' : ' ' },
		userEvent: 'input',
	});
}

const hideBlock = Decoration.replace({});
const bulletMark = Decoration.mark({ class: 'list-bullet' });
const numberMark = Decoration.mark({ class: 'list-number' });
const transparentMark = Decoration.mark({ class: 'cm-transparent' });
const quoteBorder = Decoration.replace({ widget: new QuoteBorderWidget() });
const atomicMark = Decoration.mark({});

/** The decorations that draw block markers like Obsidian does off the cursor line. */
function blockDecorations(block: Block): CMRange<Decoration>[] {
	const out: CMRange<Decoration>[] = [];
	const isTask = block.parts.some((p) => p.kind === 'task');
	for (const part of block.parts) {
		switch (part.kind) {
			case 'heading':
				out.push(hideBlock.range(part.from, part.to));
				break;
			case 'bullet':
				if (isTask) {
					out.push(hideBlock.range(part.from, part.to));
				} else {
					// Same as Obsidian: a class on the "-" itself, so it stays inside
					// the list marker's element and keeps the same indentation.
					out.push(bulletMark.range(part.from, part.from + 1));
				}
				break;
			case 'number':
				out.push(numberMark.range(part.from, part.to));
				break;
			case 'task':
				out.push(
					Decoration.replace({ widget: new CheckboxWidget(part.task ?? ' ') }).range(part.from, part.to),
				);
				break;
			case 'quote':
				out.push((part.firstLevel ? transparentMark : quoteBorder).range(part.from, part.from + 1));
				break;
		}
	}
	return out;
}

class LiveReadView {
	decorations: DecorationSet = Decoration.none;
	/** Ranges the cursor jumps over: hidden markers and block markers. */
	atomic: DecorationSet = Decoration.none;
	hidden: Range[] = [];
	pairs: MarkerPair[] = [];
	links: LinkSpan[] = [];
	linkEnds: Range[] = [];
	blocks: Block[] = [];
	/** Ranges where typed text always goes after the range (see insertPosition). */
	typeAfter: Range[] = [];

	constructor(view: EditorView) {
		this.compute(view);
	}

	/** True when there is anything for the editing helpers to handle. */
	get active() {
		return this.hidden.length > 0 || this.blocks.length > 0;
	}

	update(update: ViewUpdate) {
		if (
			update.docChanged ||
			update.viewportChanged ||
			syntaxTree(update.startState) !== syntaxTree(update.state) ||
			isLivePreview(update.startState) !== isLivePreview(update.state)
		) {
			this.compute(update.view);
		}
	}

	private compute(view: EditorView) {
		const { state } = view;
		const live = isLivePreview(state);
		const lines = live ? collectLines(view) : [];
		const result: HiddenResult = computeHidden(lines.map((l) => l.tokens));
		const callouts = new Map<number, boolean>();
		const blocks = lines
			.map((l) => (inCallout(state, l.from, callouts) ? null : parseBlock(l.from, l.text, l.tokens)))
			.filter((b): b is Block => b !== null)
			.sort((a, b) => a.from - b.from);

		this.pairs = result.pairs;
		this.links = result.links;
		this.linkEnds = result.linkEnds;
		this.blocks = blocks;
		this.typeAfter = [...result.linkEnds, ...blocks];
		this.hidden = result.hidden;
		this.decorations = Decoration.set(
			[
				...result.hidden.map((r) => hideMarker.range(r.from, r.to)),
				...blocks.flatMap((b) => blockDecorations(b)),
			],
			true,
		);
		this.atomic = Decoration.set(
			mergeRanges([...result.hidden, ...blocks]).map((r) => atomicMark.range(r.from, r.to)),
			true,
		);
	}
}

const liveReadPlugin = ViewPlugin.fromClass(LiveReadView, {
	decorations: (v) => v.decorations,
});

function singleCursor(view: EditorView): number | null {
	const { ranges } = view.state.selection;
	if (ranges.length !== 1 || !ranges[0]!.empty) return null;
	return ranges[0]!.head;
}

function prevBreak(state: EditorState, p: number): number {
	const line = state.doc.lineAt(p);
	if (p === line.from) return p - 1;
	return line.from + findClusterBreak(line.text, p - line.from, false);
}

function nextBreak(state: EditorState, p: number): number {
	const line = state.doc.lineAt(p);
	if (p === line.to) return p + 1;
	return line.from + findClusterBreak(line.text, p - line.from, true);
}

function applyDelete(view: EditorView, del: Range | null, userEvent: string): boolean {
	if (!del) return false;
	if (del.from < del.to) {
		view.dispatch({
			changes: { from: del.from, to: del.to },
			selection: { anchor: del.from },
			userEvent,
			scrollIntoView: true,
		});
	}
	return true;
}

function arrow(forward: boolean) {
	return (view: EditorView): boolean => {
		const p = view.plugin(liveReadPlugin);
		const pos = singleCursor(view);
		if (!p || pos === null || !p.active) return false;
		const start = skipHiddenEdge(pos, p.hidden, forward);
		const moved = view.moveByChar(EditorSelection.cursor(start), forward).head;
		if (moved === start) return false;
		const target = skipBlock(skipHiddenEdge(moved, p.hidden, moved > start), p.blocks, moved > start);
		view.dispatch({
			selection: { anchor: target },
			userEvent: 'select',
			scrollIntoView: true,
		});
		return true;
	};
}

const editKeys = keymap.of([
	{ key: 'ArrowLeft', run: arrow(false) },
	{ key: 'ArrowRight', run: arrow(true) },
	{
		key: 'Backspace',
		run: (view) => {
			const p = view.plugin(liveReadPlugin);
			const pos = singleCursor(view);
			if (!p || pos === null || !p.active) return false;
			const del = backspaceRange(pos, p.hidden, p.pairs, (x) => prevBreak(view.state, x), p.blocks);
			return applyDelete(view, del, 'delete.backward');
		},
	},
	{
		key: 'Delete',
		run: (view) => {
			const p = view.plugin(liveReadPlugin);
			const pos = singleCursor(view);
			if (!p || pos === null || !p.active) return false;
			const del = deleteForwardRange(
				pos,
				p.hidden,
				p.pairs,
				view.state.doc.length,
				(x) => nextBreak(view.state, x),
				p.blocks,
			);
			return applyDelete(view, del, 'delete.forward');
		},
	},
]);

// Typing right after a hidden marker goes before it instead. See insertPosition.
const edgeTyping = EditorView.inputHandler.of((view, from, to, text) => {
	if (from !== to || view.composing) return false;
	const p = view.plugin(liveReadPlugin);
	if (!p || !p.active || singleCursor(view) !== from) return false;
	const pos = insertPosition(from, p.hidden, p.typeAfter);
	if (pos === from) return false;
	view.dispatch({
		changes: { from: pos, insert: text },
		selection: { anchor: pos + text.length },
		userEvent: 'input.type',
		scrollIntoView: true,
	});
	return true;
});

const setPending = StateEffect.define<Kind[]>();

/**
 * Styles turned on or off with the toggle commands since the cursor last
 * moved. Nothing is written to the file until the user types. Any edit or
 * cursor move clears them.
 */
const pendingField = StateField.define<Kind[]>({
	create: () => [],
	update(value, tr) {
		for (const e of tr.effects) if (e.is(setPending)) return e.value;
		if (tr.docChanged || (tr.selection && !tr.selection.eq(tr.startState.selection))) {
			return value.length ? [] : value;
		}
		return value;
	},
});

const setDeferred = StateEffect.define<Deferred | null>();

/** Spaces typed after a span's closing marker, waiting for a letter. */
const deferredField = StateField.define<Deferred | null>({
	create: () => null,
	update(value, tr) {
		for (const e of tr.effects) if (e.is(setDeferred)) return e.value;
		if (tr.docChanged || (tr.selection && !tr.selection.eq(tr.startState.selection))) return null;
		return value;
	},
});

// Typing with pending styles writes the markers together with the text.
// Spaces at the end of a styled span go after its closing marker until a
// letter follows (see planSpaceInput).
const styledTyping = EditorView.inputHandler.of((view, from, to, text) => {
	if (from !== to || view.composing || singleCursor(view) !== from) return false;
	const p = view.plugin(liveReadPlugin);
	const pending = view.state.field(pendingField, false);
	const deferred = view.state.field(deferredField, false) ?? null;
	if (!p || !pending) return false;
	const keep = setPending.of(pending);
	const apply = (spec: TransactionSpec) =>
		view.dispatch({ userEvent: 'input.type', scrollIntoView: true, ...spec });

	if (isSpace(text)) {
		const space = planSpaceInput(from, text, p.pairs, p.hidden, deferred, p.typeAfter);
		if (space) {
			apply({
				changes: { from: space.from, insert: space.insert },
				selection: { anchor: space.cursor },
				effects: [keep, setDeferred.of(space.deferred)],
			});
			return true;
		}
		if (!pending.length) return false;
		// A space before the first letter of a pending style stays plain.
		const at = insertPosition(from, p.hidden, p.typeAfter);
		apply({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, effects: keep });
		return true;
	}

	let styles = pending;
	if (deferred && from === deferred.end) {
		if (!pending.length) {
			const move = planDeferredLetter(deferred, text, view.state.sliceDoc(deferred.from, deferred.to));
			apply({ changes: move.changes, selection: { anchor: move.cursor } });
			return true;
		}
		// Toggling a style of the span off after the space: the span stays
		// closed before the space, so that style needs nothing more.
		const closed = p.pairs.filter((x) => x.close.from >= deferred.from && x.close.to <= deferred.to);
		styles = pending.filter((k) => !closed.some((x) => x.kind === k));
	}
	if (!styles.length) {
		if (styles === pending) return false;
		apply({ changes: { from, insert: text }, selection: { anchor: from + text.length } });
		return true;
	}
	const edit = planPendingInput({
		pos: from,
		text,
		pending: styles,
		pairs: p.pairs,
		hidden: p.hidden,
		linkEnds: p.typeAfter,
		slice: (a, b) => view.state.sliceDoc(a, b),
	});
	apply({ changes: { from: edit.from, insert: edit.insert }, selection: { anchor: edit.cursor } });
	return true;
});

/**
 * Runs a style toggle (Ctrl+B and friends) the Live Read way. With no
 * selection it turns the style on or off for the next typed text. Returns
 * false when Obsidian's own command should run instead: Live Read is off,
 * the editor is not in Live Preview, or there is a selection.
 */
export function toggleStyleAtCursor(view: EditorView, kind: Kind): boolean {
	const pending = view.state.field(pendingField, false);
	if (!pending || !isLivePreview(view.state) || singleCursor(view) === null) return false;
	view.dispatch({ effects: setPending.of(togglePending(pending, kind)) });
	return true;
}

export interface LinkContext {
	/** The link under the cursor, or null when creating a new one. */
	link: LinkSpan | null;
	/** What a new link replaces: the selection (maybe empty). */
	range: Range;
	kind: LinkKind | null;
	text: string;
	target: string;
}

/**
 * What the link popup should show, or null when Obsidian's own command
 * should run instead (Live Read off, or not in Live Preview).
 */
export function linkContext(view: EditorView): LinkContext | null {
	const p = view.plugin(liveReadPlugin);
	if (!p || !isLivePreview(view.state) || view.state.selection.ranges.length !== 1) return null;
	const { from, to, head } = view.state.selection.main;
	const link = linkAt(head, p.links) ?? null;
	const slice = (r: Range) => view.state.sliceDoc(r.from, r.to);
	if (link) {
		return {
			link,
			range: { from: link.from, to: link.to },
			kind: link.kind,
			text: slice(link.text),
			target: cleanTarget(link.kind, slice(link.target)),
		};
	}
	return { link: null, range: { from, to }, kind: null, text: view.state.sliceDoc(from, to), target: '' };
}

/** Writes the popup result. Returns false when nothing changed. */
export function applyLinkEdit(
	view: EditorView,
	ctx: LinkContext,
	text: string,
	target: string,
	kind?: LinkKind,
): boolean {
	const edit = planLinkEdit(ctx.link, ctx.range, text, target, kind);
	if (!edit) return false;
	view.dispatch({
		changes: { from: edit.from, to: edit.to, insert: edit.insert },
		selection: { anchor: edit.cursor },
		userEvent: 'input',
		scrollIntoView: true,
	});
	view.focus();
	return true;
}

// A plain click on link text puts the cursor there instead of opening the
// link. Obsidian opens links from a click listener on an outer element, so
// stopping the click here is enough. Ctrl/Cmd+click still reaches Obsidian,
// which opens the link.
const linkClicks = EditorView.domEventHandlers({
	click(event, view) {
		if (event.button !== 0 || event.ctrlKey || event.metaKey) return false;
		const p = view.plugin(liveReadPlugin);
		const target = event.target as Node | null;
		if (!p || !p.links.length || !target || typeof target.nodeType !== 'number') return false;
		// Link text is drawn in its own element. A click on a whole line or on
		// the editor itself is not a click on a link.
		const el = target.nodeType === 1 ? (target as HTMLElement) : target.parentElement;
		if (!el || el === view.contentDOM || el.classList.contains('cm-line')) return false;
		let from: number;
		try {
			from = view.posAtDOM(el, 0);
		} catch {
			return false;
		}
		const to = from + (el.textContent?.length ?? 0);
		if (p.links.some((l) => l.text.from < to && from < l.text.to)) event.stopPropagation();
		return false;
	},
});

export function liveReadExtension(): Extension[] {
	return [
		liveReadPlugin,
		pendingField,
		deferredField,
		linkClicks,
		EditorView.atomicRanges.of((view) => view.plugin(liveReadPlugin)?.atomic ?? Decoration.none),
		Prec.highest(editKeys),
		Prec.highest(styledTyping),
		Prec.high(edgeTyping),
	];
}
