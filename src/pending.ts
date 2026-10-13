// Pure logic for "pending" styles: press Ctrl+B with no selection, and the
// next letters you type are bold, without anything being written to the file
// until you type. No Obsidian or CodeMirror imports, so it can be unit tested.
import { insertPosition, type Kind, type MarkerPair, type Range } from './hidden-ranges.ts';

/** Marker used when the plugin writes a new style into the text. */
export const DEFAULT_MARKER: Record<Kind, string> = {
	strong: '**',
	em: '*',
	strike: '~~',
	highlight: '==',
	code: '`',
};

/** Pressing the same style twice before typing cancels it. */
export function togglePending(pending: readonly Kind[], kind: Kind): Kind[] {
	return pending.includes(kind) ? pending.filter((k) => k !== kind) : [...pending, kind];
}

export interface PendingInput {
	/** Cursor position when the user types. */
	pos: number;
	/** The typed text. */
	text: string;
	/** Styles toggled since the cursor last moved, in press order. */
	pending: readonly Kind[];
	pairs: readonly MarkerPair[];
	hidden: Range[];
	/** The hidden part after each link's text (see insertPosition). */
	linkEnds?: readonly Range[];
	/** Reads document text, used to copy the markers of an existing span. */
	slice: (from: number, to: number) => string;
}

export interface PendingEdit {
	from: number;
	insert: string;
	/** Where the cursor goes after the edit. */
	cursor: number;
}

/**
 * What to write when the user types with pending styles.
 *
 * For each pending style:
 * - Outside a span of that style: the typed text starts a new span. Right
 *   before an existing span of that style, the text joins it instead.
 * - Inside a span of that style: the typed text is plain. At the end of the
 *   span it goes after the closing marker; in the middle the span is split.
 */
export function planPendingInput(input: PendingInput): PendingEdit {
	const { text, pending, pairs, slice } = input;
	let q = insertPosition(input.pos, input.hidden, input.linkEnds);

	const insideOf = (kind: Kind, at: number) =>
		innermost(pairs.filter((p) => p.kind === kind && p.open.to < at && at <= p.close.from));
	const startingAt = (kind: Kind, at: number) =>
		pairs.find((p) => p.kind === kind && p.open.from === at);

	// First pass: styles that only need the insert point to move (leaving a
	// span at its end, or joining a span that starts right here). Repeat so
	// nested spans like ***x*** can be left one after another.
	const left = [...new Set(pending)];
	for (let moved = true; moved; ) {
		moved = false;
		for (let i = 0; i < left.length; i++) {
			const kind = left[i]!;
			const inside = insideOf(kind, q);
			const target = inside
				? inside.close.from === q
					? inside.close.to
					: null
				: (startingAt(kind, q)?.open.to ?? null);
			if (target !== null) {
				q = target;
				left.splice(i, 1);
				moved = true;
				break;
			}
		}
	}

	// Second pass: styles that need new markers around the typed text.
	let before = '';
	let after = '';
	for (const kind of left) {
		const inside = insideOf(kind, q);
		if (inside) {
			// Split the span: close it before the text and reopen it after.
			before += markerText(kind, slice(inside.close.from, inside.close.to));
			after = markerText(kind, slice(inside.open.from, inside.open.to)) + after;
		} else {
			before += DEFAULT_MARKER[kind];
			after = DEFAULT_MARKER[kind] + after;
		}
	}

	return { from: q, insert: before + text + after, cursor: q + before.length + text.length };
}

/** True for typed text that is only spaces or tabs. */
export function isSpace(text: string): boolean {
	return /^[ \t\u00a0]+$/.test(text);
}

/**
 * A space typed at the end of a styled span. Markdown does not accept a
 * closing marker right after a space (`**word **` is not bold), so the space
 * goes after the closing marker for now. The span is remembered as
 * "deferred": if the next thing typed is a letter, the marker moves after it.
 */
export interface Deferred {
	/** The closing marker(s) that were jumped over. */
	from: number;
	to: number;
	/** End of the spaces typed after the marker. */
	end: number;
}

export interface SpaceEdit extends PendingEdit {
	deferred: Deferred;
}

/** Plans a typed space at `pos`, or returns null if it is not at a span end. */
export function planSpaceInput(
	pos: number,
	text: string,
	pairs: readonly MarkerPair[],
	hidden: Range[],
	deferred: Deferred | null,
	linkEnds: readonly Range[] = [],
): SpaceEdit | null {
	if (!isSpace(text)) return null;
	// More spaces after a deferred span keep it deferred.
	if (deferred && pos === deferred.end) {
		const end = deferred.end + text.length;
		return { from: pos, insert: text, cursor: end, deferred: { ...deferred, end } };
	}
	const q = insertPosition(pos, hidden, linkEnds);
	// Follow closing markers that touch, so ***x*** is left in one go.
	let to = q;
	for (;;) {
		const closing = pairs.filter((p) => p.close.from === to);
		if (closing.length === 0) break;
		to = Math.max(...closing.map((p) => p.close.to));
	}
	if (to === q) return null;
	const end = to + text.length;
	return { from: to, insert: text, cursor: end, deferred: { from: q, to, end } };
}

export interface MoveEdit {
	changes: { from: number; to?: number; insert: string }[];
	cursor: number;
}

/** A letter typed after deferred spaces: move the closing marker after it. */
export function planDeferredLetter(deferred: Deferred, text: string, marker: string): MoveEdit {
	const size = deferred.to - deferred.from;
	return {
		changes: [
			{ from: deferred.from, to: deferred.to, insert: '' },
			{ from: deferred.end, insert: text + marker },
		],
		cursor: deferred.end - size + text.length,
	};
}

function innermost(pairs: MarkerPair[]): MarkerPair | undefined {
	let best: MarkerPair | undefined;
	for (const p of pairs) {
		if (!best || p.open.to - p.close.from > best.open.to - best.close.from) best = p;
	}
	return best;
}

/**
 * The marker of one style, copied from an existing span when possible, so
 * `__bold__` is split as `__`. A token may hold two styles (`***`); then the
 * default marker is used, keeping the user's marker character.
 */
function markerText(kind: Kind, existing: string): string {
	const ch = existing[0];
	if (kind === 'code') return existing.length > 0 && /^`+$/.test(existing) ? existing : '`';
	const size = DEFAULT_MARKER[kind].length;
	const allowed: Record<Kind, string> = { strong: '*_', em: '*_', strike: '~', highlight: '=', code: '`' };
	if (!ch || !allowed[kind].includes(ch)) return DEFAULT_MARKER[kind];
	return ch.repeat(size);
}
