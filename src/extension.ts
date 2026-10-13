import { syntaxTree } from '@codemirror/language';
import {
	EditorSelection,
	EditorState,
	Extension,
	Prec,
	StateEffect,
	StateField,
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
import { planPendingInput, togglePending } from './pending';

const hideMarker = Decoration.replace({});

function isLivePreview(state: EditorState): boolean {
	return state.field(editorLivePreviewField, false) === true;
}

/** Marker tokens of the visible lines, grouped by line. */
function collectLines(view: EditorView): Token[][] {
	const { state } = view;
	const byLine = new Map<number, Token[]>();
	const tree = syntaxTree(state);
	for (const { from, to } of view.visibleRanges) {
		tree.iterate({
			from,
			to,
			enter: (node) => {
				if (markerKinds(node.name).length === 0) return;
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
		if (!isLivePreview(view.state)) {
			this.set([], []);
			return;
		}
		const { pairs, hidden } = computeHidden(collectLines(view));
		this.set(pairs, hidden);
	}

	private set(pairs: MarkerPair[], hidden: Range[]) {
		this.pairs = pairs;
		if (sameRanges(this.hidden, hidden)) return;
		this.hidden = hidden;
		this.decorations = Decoration.set(
			hidden.map((r) => hideMarker.range(r.from, r.to)),
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
	const pos = insertPosition(from, p.hidden);
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

// Typing with pending styles writes the markers together with the text.
const pendingTyping = EditorView.inputHandler.of((view, from, to, text) => {
	if (from !== to || view.composing) return false;
	const pending = view.state.field(pendingField, false);
	const p = view.plugin(liveReadPlugin);
	if (!pending?.length || !p || singleCursor(view) !== from) return false;
	const edit = planPendingInput({
		pos: from,
		text,
		pending,
		pairs: p.pairs,
		hidden: p.hidden,
		slice: (a, b) => view.state.sliceDoc(a, b),
	});
	view.dispatch({
		changes: { from: edit.from, insert: edit.insert },
		selection: { anchor: edit.cursor },
		userEvent: 'input.type',
		scrollIntoView: true,
	});
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

export function liveReadExtension(): Extension[] {
	return [
		liveReadPlugin,
		pendingField,
		EditorView.atomicRanges.of((view) => view.plugin(liveReadPlugin)?.decorations ?? Decoration.none),
		Prec.highest(editKeys),
		Prec.highest(pendingTyping),
		Prec.high(edgeTyping),
	];
}
