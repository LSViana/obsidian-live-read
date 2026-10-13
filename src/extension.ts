import { syntaxTree } from '@codemirror/language';
import {
	EditorSelection,
	EditorState,
	Extension,
	Prec,
	StateEffect,
	StateField,
	TransactionSpec,
	findClusterBreak,
} from '@codemirror/state';
import {
	Decoration,
	DecorationSet,
	EditorView,
	ViewPlugin,
	ViewUpdate,
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
	sameRanges,
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

/** Marker and link tokens of the visible lines, grouped by line. */
function collectLines(view: EditorView): Token[][] {
	const { state } = view;
	const byLine = new Map<number, Token[]>();
	const tree = syntaxTree(state);
	for (const { from, to } of view.visibleRanges) {
		tree.iterate({
			from,
			to,
			enter: (node) => {
				if (markerKinds(node.name).length === 0 && !isLinkToken(node.name)) return;
				const line = state.doc.lineAt(node.from).number;
				let tokens = byLine.get(line);
				if (!tokens) {
					tokens = [];
					byLine.set(line, tokens);
				}
				if (!tokens.some((t) => t.from === node.from && t.to === node.to)) {
					tokens.push({ from: node.from, to: node.to, name: node.name });
				}
			},
		});
	}
	return [...byLine.values()];
}

class LiveReadView {
	decorations: DecorationSet = Decoration.none;
	hidden: Range[] = [];
	pairs: MarkerPair[] = [];
	links: LinkSpan[] = [];
	linkEnds: Range[] = [];

	constructor(view: EditorView) {
		this.compute(view);
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
		const result: HiddenResult = isLivePreview(view.state)
			? computeHidden(collectLines(view))
			: { pairs: [], hidden: [], links: [], linkEnds: [] };
		this.pairs = result.pairs;
		this.links = result.links;
		this.linkEnds = result.linkEnds;
		if (sameRanges(this.hidden, result.hidden)) return;
		this.hidden = result.hidden;
		this.decorations = Decoration.set(
			result.hidden.map((r) => hideMarker.range(r.from, r.to)),
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
		if (!p || pos === null || p.hidden.length === 0) return false;
		const start = skipHiddenEdge(pos, p.hidden, forward);
		const moved = view.moveByChar(EditorSelection.cursor(start), forward).head;
		if (moved === start) return false;
		const target = skipHiddenEdge(moved, p.hidden, moved > start);
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
			if (!p || pos === null || p.hidden.length === 0) return false;
			const del = backspaceRange(pos, p.hidden, p.pairs, (x) => prevBreak(view.state, x));
			return applyDelete(view, del, 'delete.backward');
		},
	},
	{
		key: 'Delete',
		run: (view) => {
			const p = view.plugin(liveReadPlugin);
			const pos = singleCursor(view);
			if (!p || pos === null || p.hidden.length === 0) return false;
			const del = deleteForwardRange(pos, p.hidden, p.pairs, view.state.doc.length, (x) =>
				nextBreak(view.state, x),
			);
			return applyDelete(view, del, 'delete.forward');
		},
	},
]);

// Typing right after a hidden marker goes before it instead. See insertPosition.
const edgeTyping = EditorView.inputHandler.of((view, from, to, text) => {
	if (from !== to || view.composing) return false;
	const p = view.plugin(liveReadPlugin);
	if (!p || p.hidden.length === 0 || singleCursor(view) !== from) return false;
	const pos = insertPosition(from, p.hidden, p.linkEnds);
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
		const space = planSpaceInput(from, text, p.pairs, p.hidden, deferred, p.linkEnds);
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
		const at = insertPosition(from, p.hidden, p.linkEnds);
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
		linkEnds: p.linkEnds,
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
export function applyLinkEdit(view: EditorView, ctx: LinkContext, text: string, target: string): boolean {
	const edit = planLinkEdit(ctx.link, ctx.range, text, target);
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
		EditorView.atomicRanges.of((view) => view.plugin(liveReadPlugin)?.decorations ?? Decoration.none),
		Prec.highest(editKeys),
		Prec.highest(styledTyping),
		Prec.high(edgeTyping),
	];
}
