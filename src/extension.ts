import { syntaxTree } from '@codemirror/language';
import {
	EditorSelection,
	EditorState,
	Extension,
	Facet,
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
import { editorLivePreviewField, setIcon } from 'obsidian';
import {
	HiddenResult,
	Kind,
	MarkerPair,
	Range,
	Token,
	type BlockRange,
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
	type FenceBlock,
	fenceBackspace,
	fenceDelete,
	fenceTypingPos,
	languageOf,
	onFenceLine,
	parseFences,
	planFenceCreate,
	planLanguage,
	skipFence,
} from './fences';
import {
	type Callout,
	calloutBackspace,
	calloutClickPos,
	calloutDelete,
	calloutIcon,
	calloutMarkers,
	calloutTitlePlaceholder,
	parseCallouts,
	planCalloutType,
	planFoldToggle,
} from './callouts';
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
	/** Closed code blocks in the whole note. */
	fences: FenceBlock[] = [];
	/** Callouts in the whole note (not inside code blocks, not nested). */
	callouts: Callout[] = [];
	/** The hidden `> [!type] ` and `> ` parts of callout lines. */
	calloutMarks: BlockRange[] = [];
	private fenceDoc: EditorState['doc'] | null = null;
	/** Ranges where typed text always goes after the range (see insertPosition). */
	typeAfter: Range[] = [];

	constructor(view: EditorView) {
		this.compute(view);
	}

	/** True when there is anything for the editing helpers to handle. */
	get active() {
		return this.hidden.length > 0 || this.blocks.length > 0 || this.fences.length > 0 || this.callouts.length > 0;
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
		if (!live) {
			this.fences = [];
			this.callouts = [];
			this.fenceDoc = null;
		} else if (state.doc !== this.fenceDoc) {
			this.fences = parseFences(docLines(state.doc));
			const fences = this.fences;
			this.callouts = parseCallouts(docLines(state.doc)).filter(
				(c) => !fences.some((f) => f.open.from <= c.to && c.from <= f.close.to),
			);
			this.fenceDoc = state.doc;
		}
		this.calloutMarks = calloutMarkers(this.callouts);
		const { from: vFrom, to: vTo } = view.viewport;
		const shownFences = this.fences.filter((f) => f.close.to >= vFrom && f.open.from <= vTo);
		const shownCallouts = this.callouts.filter((c) => c.to >= vFrom && c.from <= vTo);

		this.pairs = result.pairs;
		this.links = result.links;
		this.linkEnds = result.linkEnds;
		this.blocks = blocks;
		this.typeAfter = [...result.linkEnds, ...blocks, ...this.calloutMarks];
		this.hidden = result.hidden;
		this.decorations = Decoration.set(
			[
				...result.hidden.map((r) => hideMarker.range(r.from, r.to)),
				...blocks.flatMap((b) => blockDecorations(b)),
				...shownFences.flatMap((f) => fenceDecorations(f, state)),
				...shownCallouts.flatMap((c) => calloutDecorations(c)),
			],
			true,
		);
		this.atomic = Decoration.set(
			mergeRanges([
				...result.hidden,
				...blocks,
				...shownFences.flatMap((f) => [f.open, f.close]),
				...calloutMarkers(shownCallouts),
			])
				.filter((r) => r.to > r.from)
				.map((r) => atomicMark.range(r.from, r.to)),
			true,
		);
	}
}

/** The note's lines with their start offsets, for the fence parser. */
function* docLines(doc: EditorState['doc']) {
	let from = 0;
	for (const text of doc.iterLines()) {
		yield { from, text };
		from += text.length + 1;
	}
}

/** Lets the plugin open its language popup from the code block label. */
type LanguagePicker = (current: string, apply: (lang: string) => void) => void;

const languagePicker = Facet.define<LanguagePicker, LanguagePicker | null>({
	combine: (values) => values[0] ?? null,
});

class LanguageLabel extends WidgetType {
	constructor(readonly lang: string) {
		super();
	}
	eq(other: LanguageLabel) {
		return other.lang === this.lang;
	}
	toDOM(view: EditorView) {
		// Same class as Obsidian's label, so it sits in the same corner.
		const span = document.createElement('span');
		span.className = 'code-block-flair live-read-lang';
		span.textContent = this.lang || 'plain text';
		span.setAttribute('aria-label', 'Change language');
		span.addEventListener('mousedown', (e) => e.preventDefault());
		span.addEventListener('click', (e) => {
			e.preventDefault();
			editLanguage(view, span);
		});
		return span;
	}
}

/** Opens the language popup for the block whose label is `el`. */
function editLanguage(view: EditorView, el: HTMLElement) {
	const pick = view.state.facet(languagePicker);
	const p = view.plugin(liveReadPlugin);
	if (!pick || !p) return;
	let pos: number;
	try {
		pos = view.posAtDOM(el);
	} catch {
		return;
	}
	const block = p.fences.find((f) => f.open.to === pos);
	if (!block) return;
	const current = languageOf(block, (a, b) => view.state.sliceDoc(a, b));
	pick(current, (lang) => {
		// The note may have changed while the popup was open.
		const now = view.plugin(liveReadPlugin)?.fences.find((f) => f.open.from === block.open.from);
		if (!now) return;
		const edit = planLanguage(now, lang);
		view.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, userEvent: 'input' });
	});
}

/** Hides both fence lines and shows the language label, like Obsidian off the cursor. */
function fenceDecorations(block: FenceBlock, state: EditorState): CMRange<Decoration>[] {
	const lang = languageOf(block, (a, b) => state.sliceDoc(a, b));
	return [
		hideBlock.range(block.open.from, block.open.to),
		Decoration.widget({ widget: new LanguageLabel(lang), side: 1 }).range(block.open.to),
		hideBlock.range(block.close.from, block.close.to),
	];
}

/** Lets the plugin open its callout type menu from the callout icon. */
type CalloutTypePicker = (current: string, apply: (type: string) => void, anchor: HTMLElement) => void;

const calloutTypePicker = Facet.define<CalloutTypePicker, CalloutTypePicker | null>({
	combine: (values) => values[0] ?? null,
});

/** Finds the callout whose header starts at the widget's position. */
function calloutAtWidget(view: EditorView, el: HTMLElement, at: 'start' | 'end'): Callout | null {
	const p = view.plugin(liveReadPlugin);
	if (!p) return null;
	let pos: number;
	try {
		pos = view.posAtDOM(el);
	} catch {
		return null;
	}
	return p.callouts.find((c) => (at === 'start' ? c.header.lineFrom : c.header.lineTo) === pos) ?? null;
}

/** Icon (click: change type), plus the type name when the title is empty. */
class CalloutHead extends WidgetType {
	constructor(
		readonly type: string,
		readonly emptyTitle: boolean,
	) {
		super();
	}
	eq(other: CalloutHead) {
		return other.type === this.type && other.emptyTitle === this.emptyTitle;
	}
	toDOM(view: EditorView) {
		const wrap = document.createElement('span');
		wrap.className = 'live-read-callout-head';
		const icon = document.createElement('span');
		icon.className = 'callout-icon live-read-callout-icon';
		icon.setAttribute('aria-label', 'Change callout type');
		setIcon(icon, calloutIcon(this.type));
		// Themes and custom types set the icon in CSS (--callout-icon).
		window.requestAnimationFrame(() => {
			const fromCss = window.getComputedStyle(icon).getPropertyValue('--callout-icon').trim();
			if (fromCss && fromCss !== calloutIcon(this.type)) setIcon(icon, fromCss);
		});
		icon.addEventListener('mousedown', (e) => e.preventDefault());
		icon.addEventListener('click', (e) => {
			e.preventDefault();
			const pick = view.state.facet(calloutTypePicker);
			const callout = calloutAtWidget(view, wrap, 'start');
			if (!pick || !callout) return;
			pick(callout.type, (type) => {
				const now = view.plugin(liveReadPlugin)?.callouts.find((c) => c.from === callout.from);
				if (!now) return;
				const edit = planCalloutType(now, type);
				view.dispatch({ changes: edit, userEvent: 'input' });
			}, icon);
		});
		wrap.appendChild(icon);
		if (this.emptyTitle) {
			const placeholder = document.createElement('span');
			placeholder.className = 'callout-title-inner live-read-callout-placeholder';
			placeholder.textContent = calloutTitlePlaceholder(this.type);
			wrap.appendChild(placeholder);
		}
		return wrap;
	}
}

/** The fold arrow at the end of a foldable callout's header (click: +/-). */
class CalloutFold extends WidgetType {
	constructor(readonly collapsed: boolean) {
		super();
	}
	eq(other: CalloutFold) {
		return other.collapsed === this.collapsed;
	}
	toDOM(view: EditorView) {
		const fold = document.createElement('span');
		fold.className = `callout-fold live-read-callout-fold${this.collapsed ? ' is-collapsed' : ''}`;
		fold.setAttribute('aria-label', this.collapsed ? 'Folded (click to unfold)' : 'Click to fold');
		setIcon(fold, 'lucide-chevron-down');
		fold.addEventListener('mousedown', (e) => e.preventDefault());
		fold.addEventListener('click', (e) => {
			e.preventDefault();
			const callout = calloutAtWidget(view, fold, 'end');
			const edit = callout && planFoldToggle(callout);
			if (edit) view.dispatch({ changes: edit, userEvent: 'input' });
		});
		return fold;
	}
}

/**
 * Draws a callout around its lines with Obsidian's classes (so themes and
 * custom callout colors apply), hides `> [!type]` and `> `, and adds the
 * icon and fold arrow.
 */
function calloutDecorations(c: Callout): CMRange<Decoration>[] {
	const lines = [c.header, ...c.body];
	const out: CMRange<Decoration>[] = lines.map((line, i) => {
		// Paragraph spacing like Obsidian's (--p-spacing above and below each
		// paragraph, shared between two paragraphs): space above the first
		// body paragraph, below the last one, and an empty line between two
		// paragraphs is exactly one spacing tall.
		const b = i - 1;
		const blank = b >= 0 && c.body[b]!.blank === true;
		return Decoration.line({
			class: [
				'callout',
				'live-read-callout',
				i === 0 ? 'live-read-callout-first live-read-callout-title' : '',
				i === lines.length - 1 ? 'live-read-callout-last' : '',
				blank ? 'live-read-callout-gap' : '',
				b === 0 && !blank ? 'live-read-callout-p-first' : '',
				b >= 0 && b === c.body.length - 1 && !blank ? 'live-read-callout-p-last' : '',
			]
				.filter(Boolean)
				.join(' '),
			attributes: { 'data-callout': c.type.toLowerCase() },
		}).range(line.lineFrom);
	});
	out.push(
		Decoration.replace({ widget: new CalloutHead(c.type, c.title.from >= c.title.to) }).range(
			c.header.lineFrom,
			c.header.to,
		),
	);
	if (c.fold) out.push(Decoration.widget({ widget: new CalloutFold(c.fold === '-'), side: 1 }).range(c.header.lineTo));
	for (const line of c.body) {
		if (line.to > line.lineFrom) out.push(hideBlock.range(line.lineFrom, line.to));
	}
	return out;
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
		const dir = moved > start;
		const target = skipFence(
			skipBlock(skipHiddenEdge(moved, p.hidden, dir), [...p.blocks, ...p.calloutMarks], dir),
			p.fences,
			dir,
			view.state.doc.length,
		);
		view.dispatch({
			selection: { anchor: target },
			userEvent: 'select',
			scrollIntoView: true,
		});
		return true;
	};
}

/**
 * Up/Down: when the normal move would land on a hidden fence line, keep
 * going one more line so the cursor goes straight into or out of the code.
 */
function vertical(forward: boolean) {
	return (view: EditorView): boolean => {
		const p = view.plugin(liveReadPlugin);
		if (!p || !p.fences.length || singleCursor(view) === null) return false;
		let range;
		try {
			range = view.moveVertically(view.state.selection.main, forward);
			if (!onFenceLine(range.head, p.fences)) return false;
			for (let i = 0; i < 3 && onFenceLine(range.head, p.fences); i++) {
				const next = view.moveVertically(range, forward);
				if (next.head === range.head) break;
				range = next;
			}
		} catch {
			return false;
		}
		if (onFenceLine(range.head, p.fences)) {
			range = EditorSelection.cursor(skipFence(range.head, p.fences, forward, view.state.doc.length));
		}
		view.dispatch({ selection: EditorSelection.create([range]), userEvent: 'select', scrollIntoView: true });
		return true;
	};
}

const editKeys = keymap.of([
	{ key: 'ArrowLeft', run: arrow(false) },
	{ key: 'ArrowRight', run: arrow(true) },
	{ key: 'ArrowUp', run: vertical(false) },
	{ key: 'ArrowDown', run: vertical(true) },
	{
		key: 'Backspace',
		run: (view) => {
			const p = view.plugin(liveReadPlugin);
			const pos = singleCursor(view);
			if (!p || pos === null || !p.active) return false;
			const fence = fenceBackspace(pos, p.fences) ?? calloutBackspace(pos, p.callouts);
			if (fence) {
				if (fence.from < fence.to) {
					view.dispatch({
						changes: { from: fence.from, to: fence.to },
						selection: { anchor: fence.cursor },
						userEvent: 'delete.backward',
						scrollIntoView: true,
					});
				}
				return true;
			}
			const del = backspaceRange(pos, p.hidden, p.pairs, (x) => prevBreak(view.state, x), [...p.blocks, ...p.calloutMarks]);
			return applyDelete(view, del, 'delete.backward');
		},
	},
	{
		key: 'Delete',
		run: (view) => {
			const p = view.plugin(liveReadPlugin);
			const pos = singleCursor(view);
			if (!p || pos === null || !p.active) return false;
			if (fenceDelete(pos, p.fences) || calloutDelete(pos, p.callouts)) return true;
			const del = deleteForwardRange(
				pos,
				p.hidden,
				p.pairs,
				view.state.doc.length,
				(x) => nextBreak(view.state, x),
				[...p.blocks, ...p.calloutMarks],
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

// Code blocks: typing ``` on an empty line makes a block, and text typed on
// a hidden fence line goes into the code instead.
const fenceTyping = EditorView.inputHandler.of((view, from, to, text) => {
	if (from !== to || view.composing || singleCursor(view) !== from) return false;
	const p = view.plugin(liveReadPlugin);
	if (!p || !isLivePreview(view.state)) return false;
	const { doc } = view.state;
	const line = doc.lineAt(from);
	const before = function* () {
		for (let n = 1; n < line.number; n++) {
			const l = doc.line(n);
			yield { from: l.from, text: l.text };
		}
	};
	const create = planFenceCreate({ from: line.from, text: line.text }, from - line.from, text, before());
	if (create) {
		view.dispatch({
			changes: { from: create.from, to: create.to, insert: create.insert },
			selection: { anchor: create.cursor },
			userEvent: 'input.type',
			scrollIntoView: true,
		});
		return true;
	}
	if (!onFenceLine(from, p.fences)) return false;
	const at = fenceTypingPos(from, p.fences);
	view.dispatch({
		changes: { from: at, insert: text },
		selection: { anchor: at + text.length },
		userEvent: 'input.type',
		scrollIntoView: true,
	});
	return true;
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
/** Where in a rendered element's text the caret is, as a character count. */
function textOffset(root: Node, node: Node, offset: number): number {
	let count = 0;
	const walker = root.ownerDocument!.createTreeWalker(root, 4 /* text nodes */);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		if (n === node) return count + offset;
		// The caret is in an element: count the text of its children before it.
		if (node.nodeType === 1 && node.childNodes[offset]?.contains(n)) return count;
		count += n.textContent?.length ?? 0;
	}
	return count;
}

/** The text node and offset under the mouse, when the browser can tell. */
function caretAt(e: MouseEvent): { node: Node; offset: number } | null {
	const doc = (e.target as Node | null)?.ownerDocument as
		| (Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null })
		| undefined;
	const range = doc?.caretRangeFromPoint?.(e.clientX, e.clientY) as unknown as
		| { startContainer: Node; startOffset: number }
		| null
		| undefined;
	return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

// Obsidian selects a whole callout when its rendered box is clicked. With
// Live Read on, a click puts the cursor where it lands instead. These run in
// the capture phase so they come before Obsidian's own click handling.
const calloutClicks = ViewPlugin.fromClass(
	class {
		private readonly down = (e: MouseEvent) => this.handle(e, true);
		private readonly up = (e: MouseEvent) => this.handle(e, false);

		constructor(readonly view: EditorView) {
			view.contentDOM.addEventListener('mousedown', this.down, true);
			view.contentDOM.addEventListener('mouseup', this.up, true);
			view.contentDOM.addEventListener('click', this.up, true);
		}

		destroy() {
			this.view.contentDOM.removeEventListener('mousedown', this.down, true);
			this.view.contentDOM.removeEventListener('mouseup', this.up, true);
			this.view.contentDOM.removeEventListener('click', this.up, true);
		}

		private handle(e: MouseEvent, place: boolean) {
			const { view } = this;
			if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
			const target = e.target as HTMLElement | null;
			const box = target?.closest?.('.cm-callout');
			if (!box || !view.contentDOM.contains(box)) return;
			// Links, checkboxes, buttons and the fold arrow keep working.
			if (target!.closest('a, input, button, .embed-actions, .callout-fold, .interactive-child')) return;
			const p = view.plugin(liveReadPlugin);
			if (!p || !isLivePreview(view.state) || !p.callouts.length) return;
			e.preventDefault();
			e.stopPropagation();
			if (!place) return;

			let pos: number;
			try {
				pos = view.posAtDOM(box);
			} catch {
				return;
			}
			const callout =
				p.callouts.find((c) => c.from <= pos && pos <= c.to) ?? p.callouts.find((c) => c.from >= pos);
			if (!callout) return;
			const caret = caretAt(e) ?? { node: target!, offset: 0 };
			const title = box.querySelector('.callout-title-inner');
			const content = box.querySelector('.callout-content');
			const slice = (a: number, b: number) => view.state.sliceDoc(a, b);
			let anchor: number;
			if (title?.contains(caret.node)) {
				anchor = calloutClickPos(callout, 'title', title.textContent ?? '', textOffset(title, caret.node, caret.offset), slice);
			} else if (content?.contains(caret.node)) {
				anchor = calloutClickPos(callout, 'body', content.textContent ?? '', textOffset(content, caret.node, caret.offset), slice);
			} else {
				anchor = callout.title.to;
			}
			view.focus();
			view.dispatch({ selection: { anchor }, scrollIntoView: true, userEvent: 'select.pointer' });
		}
	},
);

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

export interface LiveReadOptions {
	/** Opens a popup to change a code block's language (the label click). */
	pickLanguage?: LanguagePicker;
	/** Opens a menu to change a callout's type (the icon click). */
	pickCalloutType?: CalloutTypePicker;
}

export function liveReadExtension(options: LiveReadOptions = {}): Extension[] {
	return [
		liveReadPlugin,
		pendingField,
		deferredField,
		linkClicks,
		calloutClicks,
		options.pickLanguage ? languagePicker.of(options.pickLanguage) : [],
		options.pickCalloutType ? calloutTypePicker.of(options.pickCalloutType) : [],
		// Lets styles.css hide Obsidian's own code block label while Live Read is on.
		EditorView.editorAttributes.of({ class: 'live-read' }),
		EditorView.atomicRanges.of((view) => view.plugin(liveReadPlugin)?.atomic ?? Decoration.none),
		Prec.highest(editKeys),
		Prec.highest(fenceTyping),
		Prec.highest(styledTyping),
		Prec.high(edgeTyping),
	];
}
