// Pure logic for Live Read. No Obsidian or CodeMirror imports here, so it can
// be unit tested with plain Node.
import { type LinkSpan, parseLinks } from './links.ts';

export interface Token {
	from: number;
	to: number;
	/** Obsidian syntax node name, e.g. "formatting_formatting-strong_strong". */
	name: string;
}

export interface Range {
	from: number;
	to: number;
}

export type Kind = 'strong' | 'em' | 'strike' | 'highlight' | 'code';

/** Pairs are inline styles, or links (their hidden open and close parts). */
export type PairKind = Kind | 'link';

export interface MarkerPair {
	kind: PairKind;
	open: Range;
	close: Range;
}

const KIND_BY_CLASS: Record<string, Kind> = {
	'formatting-strong': 'strong',
	'formatting-em': 'em',
	'formatting-strikethrough': 'strike',
	'formatting-highlight': 'highlight',
	'formatting-code': 'code',
};

/** Which inline styles a token is a marker for. Empty if it is not a marker. */
export function markerKinds(name: string): Kind[] {
	const classes = name.split(/[_\s]+/);
	if (!classes.includes('formatting')) return [];
	const kinds: Kind[] = [];
	for (const c of classes) {
		const kind = KIND_BY_CLASS[c];
		if (kind && !kinds.includes(kind)) kinds.push(kind);
	}
	return kinds;
}

interface LinePairs {
	pairs: MarkerPair[];
	hidden: Range[];
}

/**
 * Pairs opening and closing markers inside one line. A marker is hidden only
 * when every style it carries has a partner on the same line, so a marker the
 * user is still typing (no closing side yet) stays visible.
 */
function pairLine(tokens: Token[]): LinePairs {
	const open = new Map<Kind, Token>();
	const pairs: MarkerPair[] = [];
	const paired = new Map<Token, Set<Kind>>();
	const markers: { token: Token; kinds: Kind[] }[] = [];

	const sorted = [...tokens].sort((a, b) => a.from - b.from);
	for (const token of sorted) {
		const kinds = markerKinds(token.name);
		if (kinds.length === 0 || token.to <= token.from) continue;
		markers.push({ token, kinds });
		for (const kind of kinds) {
			const start = open.get(kind);
			if (start) {
				open.delete(kind);
				pairs.push({
					kind,
					open: { from: start.from, to: start.to },
					close: { from: token.from, to: token.to },
				});
				addKind(paired, start, kind);
				addKind(paired, token, kind);
			} else {
				open.set(kind, token);
			}
		}
	}

	const hidden: Range[] = [];
	for (const { token, kinds } of markers) {
		const done = paired.get(token);
		if (done && kinds.every((k) => done.has(k))) {
			hidden.push({ from: token.from, to: token.to });
		}
	}
	return { pairs, hidden };
}

function addKind(map: Map<Token, Set<Kind>>, token: Token, kind: Kind) {
	let set = map.get(token);
	if (!set) {
		set = new Set();
		map.set(token, set);
	}
	set.add(kind);
}

export interface HiddenResult {
	/** Every matched open/close pair, links included. */
	pairs: MarkerPair[];
	/** Marker ranges to hide, sorted, touching ranges merged. */
	hidden: Range[];
	/** Complete links found. */
	links: LinkSpan[];
	/** The hidden part after each link's text, like `](url)` or `]]`. */
	linkEnds: Range[];
}

/** Takes the syntax tokens of each line and returns what Live Read hides. */
export function computeHidden(lines: Token[][]): HiddenResult {
	const pairs: MarkerPair[] = [];
	const hidden: Range[] = [];
	const links: LinkSpan[] = [];
	for (const line of lines) {
		const result = pairLine(line);
		pairs.push(...result.pairs);
		hidden.push(...result.hidden);
		for (const link of parseLinks(line)) {
			links.push(link);
			pairs.push({ kind: 'link', open: link.open, close: link.close });
			hidden.push(link.open, link.close);
		}
	}
	links.sort((a, b) => a.from - b.from);
	return { pairs, hidden: mergeRanges(hidden), links, linkEnds: links.map((l) => l.close) };
}

export function mergeRanges(ranges: Range[]): Range[] {
	const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
	const out: Range[] = [];
	for (const r of sorted) {
		const last = out[out.length - 1];
		if (last && r.from <= last.to) {
			last.to = Math.max(last.to, r.to);
		} else {
			out.push({ from: r.from, to: r.to });
		}
	}
	return out;
}

function hiddenEndingAt(pos: number, hidden: Range[]): Range | undefined {
	return hidden.find((r) => r.to === pos && r.from < r.to);
}

function hiddenStartingAt(pos: number, hidden: Range[]): Range | undefined {
	return hidden.find((r) => r.from === pos && r.from < r.to);
}

/**
 * Where typed text goes when the cursor is at `pos`.
 *
 * A hidden marker has two cursor spots that look the same on screen: before
 * it and after it. Rule (same as Obsidian/Typora): text typed at the end of a
 * styled span stays inside it, text typed at the start goes outside. Both
 * cases mean "if the cursor is right after a hidden marker, type before it".
 */
export function insertPosition(pos: number, hidden: Range[], linkEnds: readonly Range[] = []): number {
	const r = hiddenEndingAt(pos, hidden);
	const q = r ? r.from : pos;
	// Links are different: text typed at the end of a link goes after it,
	// so typing after [[note]] does not change which note it points to.
	const end = linkEnds.find((l) => l.from === q);
	return end ? end.to : q;
}

/**
 * Range Backspace should delete when the cursor is at `pos`, or null to let
 * the editor handle it. Without this, Backspace right after a hidden marker
 * would delete the whole marker and break the formatting.
 *
 * `prevBreak(p)` returns the start of the character before `p` (the editor
 * knows about emoji and line breaks; tests can pass `p => p - 1`).
 */
export function backspaceRange(
	pos: number,
	hidden: Range[],
	pairs: MarkerPair[],
	prevBreak: (p: number) => number,
): Range | null {
	const anchor = hiddenEndingAt(pos, hidden)?.from ?? pos;
	if (anchor <= 0) return anchor === pos ? null : { from: 0, to: 0 };
	const del = { from: prevBreak(anchor), to: anchor };
	const out = expandEmptied(del, hidden, pairs);
	if (anchor === pos && out === del) return null;
	return out;
}

/** Same as backspaceRange, for the Delete key (deletes forward). */
export function deleteForwardRange(
	pos: number,
	hidden: Range[],
	pairs: MarkerPair[],
	docLength: number,
	nextBreak: (p: number) => number,
): Range | null {
	const anchor = hiddenStartingAt(pos, hidden)?.to ?? pos;
	if (anchor >= docLength) return anchor === pos ? null : { from: docLength, to: docLength };
	const del = { from: anchor, to: nextBreak(anchor) };
	const out = expandEmptied(del, hidden, pairs);
	if (anchor === pos && out === del) return null;
	return out;
}

/**
 * If deleting `del` would leave a styled span with no text (like `**x**`
 * becoming `****`), delete its markers too, so no bare markers reappear.
 * Works on the hidden marker blocks on both sides, so nested styles like
 * `***x***` are removed together whatever order their markers close in.
 * Returns `del` itself when nothing changes.
 */
export function expandEmptied(del: Range, hidden: Range[], pairs: MarkerPair[]): Range {
	const before = hiddenEndingAt(del.from, hidden);
	const after = hiddenStartingAt(del.to, hidden);
	if (!before || !after) return del;
	const within = (r: Range, block: Range) => r.from >= block.from && r.to <= block.to;
	const matched = pairs.filter((p) => within(p.open, before) && within(p.close, after));
	if (matched.length === 0) return del;
	const from = Math.min(...matched.map((p) => p.open.from));
	const to = Math.max(...matched.map((p) => p.close.to));
	// Markers of other spans (like the end of a previous span) must survive.
	const overlaps = (r: Range, a: number, b: number) => r.from < b && a < r.to;
	const conflict = pairs.some(
		(p) =>
			!matched.includes(p) &&
			[p.open, p.close].some((r) => overlaps(r, from, del.from) || overlaps(r, del.to, to)),
	);
	return conflict ? del : { from, to };
}

/**
 * A cursor before a hidden marker and one after it look the same on screen.
 * After the arrow keys move to `pos`, skip to the other side of such a
 * marker so every key press moves the cursor visibly.
 */
export function skipHiddenEdge(pos: number, hidden: Range[], forward: boolean): number {
	const inside = hidden.find((r) => r.from < pos && pos < r.to);
	if (inside) return forward ? inside.to : inside.from;
	const r = forward ? hiddenStartingAt(pos, hidden) : hiddenEndingAt(pos, hidden);
	if (!r) return pos;
	return forward ? r.to : r.from;
}

/** True when the hidden ranges are unchanged, to skip needless redraws. */
export function sameRanges(a: Range[], b: Range[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((r, i) => r.from === b[i]!.from && r.to === b[i]!.to);
}
