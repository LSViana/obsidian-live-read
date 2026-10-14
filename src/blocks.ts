// Pure logic for block markers at the start of a line: headings (`# `),
// bullets (`- `), numbers (`1. `), checkboxes (`- [ ] `) and quotes (`> `).
// No Obsidian or CodeMirror imports, so it can be unit tested with Node.
import type { BlockRange, Token } from './hidden-ranges.ts';

export type BlockPartKind = 'heading' | 'bullet' | 'number' | 'task' | 'quote';

export interface BlockPart {
	kind: BlockPartKind;
	from: number;
	to: number;
	/** For checkboxes: the character between the brackets (' ' or 'x'). */
	task?: string;
	/** For quotes: Obsidian draws the first level with the line's own bar. */
	firstLevel?: boolean;
}

export interface Block extends BlockRange {
	parts: BlockPart[];
}

function classesOf(name: string): Set<string> {
	return new Set(name.split(/[_\s]+/));
}

function partKind(c: Set<string>): BlockPartKind | null {
	if (c.has('formatting-header')) return 'heading';
	if (c.has('formatting-task')) return 'task';
	if (c.has('formatting-list-ul')) return 'bullet';
	if (c.has('formatting-list-ol')) return 'number';
	if (c.has('formatting-quote')) return 'quote';
	return null;
}

/** True for tokens that may be a block marker, so the editor collects them. */
export function isBlockToken(name: string): boolean {
	return partKind(classesOf(name)) !== null;
}

/**
 * Finds the block markers at the start of one line. Only markers preceded
 * by indentation alone count. The block also covers the spaces right after
 * the last marker, so the text starts where the block ends. A heading with
 * no text yet keeps its `#` visible, as in Obsidian.
 */
export function parseBlock(lineFrom: number, text: string, tokens: readonly Token[]): Block | null {
	const sorted = [...tokens].sort((a, b) => a.from - b.from);
	const parts: BlockPart[] = [];
	let at = -1;
	for (const t of sorted) {
		const c = classesOf(t.name);
		const kind = partKind(c);
		if (!kind) continue;
		const gap = text.slice((at < 0 ? lineFrom : at) - lineFrom, t.from - lineFrom);
		if (!/^[ \t]*$/.test(gap)) break;
		const part: BlockPart = { kind, from: t.from, to: t.to };
		if (kind === 'task') part.task = text.charAt(t.from - lineFrom + 1);
		if (kind === 'quote') part.firstLevel = c.has('quote-1');
		parts.push(part);
		at = t.to;
	}
	if (!parts.length) return null;

	const after = (end: number) => {
		while (end - lineFrom < text.length && /[ \t]/.test(text.charAt(end - lineFrom))) end++;
		return end;
	};
	const heading = parts.findIndex((p) => p.kind === 'heading');
	if (heading >= 0 && !text.slice(after(parts[parts.length - 1]!.to) - lineFrom).trim()) {
		parts.splice(heading);
	}
	if (!parts.length) return null;

	return { lineFrom, from: parts[0]!.from, to: after(parts[parts.length - 1]!.to), parts };
}
