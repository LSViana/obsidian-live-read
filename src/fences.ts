// Pure logic for fenced code blocks (``` or ~~~). No Obsidian or CodeMirror
// imports, so it can be unit tested with plain Node.
import type { Range } from './hidden-ranges.ts';

export interface LineInfo {
	from: number;
	text: string;
}

export interface FenceBlock {
	/** The opening fence line, like "```js". */
	open: Range;
	/** The closing fence line. */
	close: Range;
	/** Info string range on the opening line (the language), maybe empty. */
	lang: Range;
	/** The code between the fences. Empty when there is no code line. */
	content: Range;
}

// Same shape as Obsidian's own fence check; at most 3 spaces before it.
const OPEN = /^( {0,3})(`{3,}|~{3,})([^\n]*)$/;
const CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * Finds closed code blocks. A block left open (no closing fence yet) is not
 * returned, so its fences stay visible while it is being written.
 */
export function parseFences(lines: Iterable<LineInfo>): FenceBlock[] {
	const blocks: FenceBlock[] = [];
	let open: { line: LineInfo; fence: string; lang: Range } | null = null;
	let prev: LineInfo | null = null;
	for (const line of lines) {
		if (!open) {
			const m = OPEN.exec(line.text);
			// A backtick fence's info string cannot contain a backtick.
			if (m && !(m[2]![0] === '`' && m[3]!.includes('`'))) {
				const infoStart = line.from + m[1]!.length + m[2]!.length;
				open = { line, fence: m[2]!, lang: { from: infoStart, to: line.from + line.text.length } };
			}
		} else {
			const m = CLOSE.exec(line.text);
			if (m && m[1]![0] === open.fence[0] && m[1]!.length >= open.fence.length) {
				const openTo = open.line.from + open.line.text.length;
				// A block with no code line at all stays visible: there would be
				// nowhere inside it to put the cursor.
				if (prev !== open.line) {
					blocks.push({
						open: { from: open.line.from, to: openTo },
						close: { from: line.from, to: line.from + line.text.length },
						lang: open.lang,
						content: { from: openTo + 1, to: prev!.from + prev!.text.length },
					});
				}
				open = null;
			}
		}
		prev = line;
	}
	return blocks;
}

/** True when the lines end inside a code block (a fence opened, not closed). */
export function hasOpenFence(lines: Iterable<LineInfo>): boolean {
	let fence: string | null = null;
	for (const line of lines) {
		if (!fence) {
			const m = OPEN.exec(line.text);
			if (m && !(m[2]![0] === '`' && m[3]!.includes('`'))) fence = m[2]!;
		} else {
			const m = CLOSE.exec(line.text);
			if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length) fence = null;
		}
	}
	return fence !== null;
}

/** The language written on the opening fence, without spaces around it. */
export function languageOf(block: FenceBlock, slice: (from: number, to: number) => string): string {
	return slice(block.lang.from, block.lang.to).trim();
}

/** Text typed on a hidden fence line goes into the code instead. */
export function fenceTypingPos(pos: number, blocks: readonly FenceBlock[]): number {
	for (const b of blocks) {
		if (b.open.from <= pos && pos <= b.open.to) return b.content.from;
		if (b.close.from <= pos && pos <= b.close.to) return b.content.to;
	}
	return pos;
}

/**
 * Arrow keys and hidden fence lines: landing on one moves on to the next
 * line in the same direction, so the cursor goes straight in or out of the
 * code.
 */
export function skipFence(pos: number, blocks: readonly FenceBlock[], forward: boolean, docLength: number): number {
	for (const b of blocks) {
		for (const line of [b.open, b.close]) {
			if (line.from <= pos && pos <= line.to) {
				if (forward) return line.to < docLength ? line.to + 1 : line.to;
				return line.from > 0 ? line.from - 1 : line.from;
			}
		}
	}
	return pos;
}

/** True when `pos` is on a hidden fence line. */
export function onFenceLine(pos: number, blocks: readonly FenceBlock[]): boolean {
	return blocks.some(
		(b) => (b.open.from <= pos && pos <= b.open.to) || (b.close.from <= pos && pos <= b.close.to),
	);
}

/**
 * Backspace near a code block, or null to let the editor handle it.
 * - In an empty block: remove the whole block.
 * - At the start of the code, or of the line after the block: do nothing,
 *   instead of joining text into a hidden fence line.
 */
export function fenceBackspace(pos: number, blocks: readonly FenceBlock[]): (Range & { cursor: number }) | null {
	for (const b of blocks) {
		const empty = b.content.from >= b.content.to;
		if (pos === b.content.from && empty) return { from: b.open.from, to: b.close.to, cursor: b.open.from };
		if (pos === b.content.from || pos === b.close.to + 1) return { from: pos, to: pos, cursor: pos };
	}
	return null;
}

/** Delete at the end of the code, or before a block: do nothing (same reason). */
export function fenceDelete(pos: number, blocks: readonly FenceBlock[]): boolean {
	return blocks.some((b) => pos === b.content.to || pos === b.open.from - 1);
}

export interface FenceEdit extends Range {
	insert: string;
	cursor: number;
}

/**
 * Typing the third ` (or ~) on an otherwise empty line makes a code block:
 * an opening and a closing fence, with the cursor on the empty line between.
 * Not when the line is inside a block, or when a fence above is still open
 * (then the user is closing that block by hand).
 */
export function planFenceCreate(
	line: LineInfo,
	col: number,
	typed: string,
	linesBefore: Iterable<LineInfo> = [],
): FenceEdit | null {
	if (typed !== '`' && typed !== '~') return null;
	const next = line.text.slice(0, col) + typed + line.text.slice(col);
	const m = /^( {0,3})(```|~~~)$/.exec(next);
	if (!m) return null;
	if (hasOpenFence(linesBefore)) return null;
	const indent = m[1]!;
	const fence = m[2]!;
	const insert = `${indent}${fence}\n${indent}\n${indent}${fence}`;
	return {
		from: line.from,
		to: line.from + line.text.length,
		insert,
		cursor: line.from + indent.length + fence.length + 1 + indent.length,
	};
}

/** Changes the language on the opening fence. */
export function planLanguage(block: FenceBlock, lang: string): FenceEdit {
	const insert = lang.trim().replace(/[`\s]+/g, '-');
	return { from: block.lang.from, to: block.lang.to, insert, cursor: block.lang.from + insert.length };
}
