import { syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState, Extension, Prec, findClusterBreak } from '@codemirror/state';
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

export function liveReadExtension(): Extension[] {
	return [
		liveReadPlugin,
		EditorView.atomicRanges.of((view) => view.plugin(liveReadPlugin)?.decorations ?? Decoration.none),
		Prec.highest(editKeys),
		Prec.high(edgeTyping),
	];
}
