// Pure logic for callouts (`> [!note] Title` and the `> ` lines under it).
// No Obsidian or CodeMirror imports, so it can be unit tested with Node.
import type { LineInfo } from './fences.ts';
import type { BlockRange, Range } from './hidden-ranges.ts';

export interface CalloutLine extends BlockRange {
	/** End of the line. */
	lineTo: number;
	/** A body line with no text: it separates paragraphs. */
	blank?: boolean;
}

export interface Callout {
	/** The type, like "note" (as written, may have capitals). */
	type: string;
	typeRange: Range;
	/** "+" or "-" when the callout can fold, else "". */
	fold: '' | '+' | '-';
	/** Where the fold sign is, or where it would go (empty range). */
	foldRange: Range;
	/** The first line. Its hidden part is `> [!type]+ `; the title follows. */
	header: CalloutLine;
	title: Range;
	/** The `> ` lines under the header. */
	body: CalloutLine[];
	from: number;
	to: number;
	/** No title and no body text. */
	empty: boolean;
}

const HEADER = /^( {0,3})>( ?)\[!([^\]\s]+)\]([+-]?)([ \t]*)(.*)$/;
const QUOTE = /^( {0,3})>( ?)(.*)$/;

/**
 * Finds callouts. A callout with a nested quote or callout inside is
 * skipped and left to Obsidian.
 */
export function parseCallouts(lines: Iterable<LineInfo>): Callout[] {
	const out: Callout[] = [];
	let current: (Callout & { nested: boolean }) | null = null;
	const finish = () => {
		if (current && !current.nested) {
			const { nested: _nested, ...callout } = current;
			out.push(callout);
		}
		current = null;
	};
	for (const line of lines) {
		const lineTo = line.from + line.text.length;
		const head = HEADER.exec(line.text);
		if (current) {
			// Inside a callout every quote line is body, even one that looks
			// like another header (Obsidian treats it as text too).
			const q = QUOTE.exec(line.text);
			if (q) {
				const markerTo = line.from + q[1]!.length + 1 + q[2]!.length;
				if (q[3]!.trimStart().startsWith('>')) current.nested = true;
				current.body.push({ lineFrom: line.from, from: line.from, to: markerTo, lineTo, blank: !q[3]!.trim() });
				current.to = lineTo;
				if (q[3]!.trim()) current.empty = false;
				continue;
			}
			finish();
		}
		if (head) {
			const [, indent, space, type, fold, gap, title] = head;
			const typeFrom = line.from + indent!.length + 1 + space!.length + 2;
			const typeTo = typeFrom + type!.length;
			const foldTo = typeTo + 1 + fold!.length;
			const titleFrom = foldTo + gap!.length;
			current = {
				type: type!,
				typeRange: { from: typeFrom, to: typeTo },
				fold: fold as '' | '+' | '-',
				foldRange: { from: typeTo + 1, to: foldTo },
				header: { lineFrom: line.from, from: line.from, to: titleFrom, lineTo },
				title: { from: titleFrom, to: lineTo },
				body: [],
				from: line.from,
				to: lineTo,
				empty: !title!.trim(),
				nested: false,
			};
		}
	}
	finish();
	return out;
}

/** Hidden marker of every callout line, like block markers (`> `). */
export function calloutMarkers(callouts: readonly Callout[]): BlockRange[] {
	return callouts.flatMap((c) => [c.header, ...c.body]).map(({ lineFrom, from, to }) => ({ lineFrom, from, to }));
}

/**
 * Backspace in a callout, or null to let the editor handle it.
 * - At the start of an empty callout: it becomes plain text (an empty line).
 * - At the start of a non-empty callout's title: nothing, so the callout
 *   is not broken by accident.
 * - At the start of a body line: join it to the line above.
 */
export function calloutBackspace(pos: number, callouts: readonly Callout[]): (Range & { cursor: number }) | null {
	for (const c of callouts) {
		const h = c.header;
		if (pos === h.to || pos === h.lineFrom) {
			if (c.empty) return { from: c.from, to: c.to, cursor: c.from };
			return { from: pos, to: pos, cursor: pos };
		}
		for (const line of c.body) {
			if (pos === line.to || pos === line.lineFrom) {
				return { from: line.lineFrom - 1, to: line.to, cursor: line.lineFrom - 1 };
			}
		}
	}
	return null;
}

/** Delete at the end of the line just above a callout: nothing (same reason). */
export function calloutDelete(pos: number, callouts: readonly Callout[]): boolean {
	return callouts.some((c) => pos === c.from - 1);
}

export interface CalloutEdit extends Range {
	insert: string;
}

/** Changes `[!type]`. */
export function planCalloutType(callout: Callout, type: string): CalloutEdit {
	return { ...callout.typeRange, insert: type.trim().replace(/[\s\]]+/g, '-') || 'note' };
}

/** Switches a foldable callout between open (+) and folded (-). */
export function planFoldToggle(callout: Callout): CalloutEdit | null {
	if (!callout.fold) return null;
	return { ...callout.foldRange, insert: callout.fold === '+' ? '-' : '+' };
}

/** The callout types Obsidian has built in, for the type picker. */
export const CALLOUT_TYPES = [
	'note',
	'abstract',
	'info',
	'todo',
	'tip',
	'success',
	'question',
	'warning',
	'failure',
	'danger',
	'bug',
	'example',
	'quote',
];

const ICONS: Record<string, string> = {
	abstract: 'lucide-clipboard-list',
	summary: 'lucide-clipboard-list',
	tldr: 'lucide-clipboard-list',
	info: 'lucide-info',
	todo: 'lucide-check-circle-2',
	important: 'lucide-flame',
	tip: 'lucide-flame',
	hint: 'lucide-flame',
	success: 'lucide-check',
	check: 'lucide-check',
	done: 'lucide-check',
	question: 'help-circle',
	help: 'help-circle',
	faq: 'help-circle',
	warning: 'lucide-alert-triangle',
	caution: 'lucide-alert-triangle',
	attention: 'lucide-alert-triangle',
	failure: 'lucide-x',
	fail: 'lucide-x',
	missing: 'lucide-x',
	danger: 'lucide-zap',
	error: 'lucide-zap',
	bug: 'lucide-bug',
	example: 'lucide-list',
	quote: 'quote-glyph',
	cite: 'quote-glyph',
};

/** Obsidian's default icon for a type (themes can change it with CSS). */
export function calloutIcon(type: string): string {
	return ICONS[type.toLowerCase()] ?? 'lucide-pencil';
}

/** What an empty title shows: the type, capitalized, as Obsidian does. */
export function calloutTitlePlaceholder(type: string): string {
	return type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
}

/**
 * Where `k` characters into the rendered text are in the markdown source.
 * The rendered text is the source without its markup, so walk both: equal
 * characters advance together, markup in the source is skipped, and extra
 * spaces in the rendered text are skipped.
 */
export function alignOffset(rendered: string, source: string, k: number): number {
	let i = 0;
	let j = 0;
	while (j < Math.min(k, rendered.length) && i < source.length) {
		if (source[i] === rendered[j]) {
			i++;
			j++;
		} else if (/\s/.test(rendered[j]!)) {
			j++;
		} else {
			i++;
		}
	}
	return j < Math.min(k, rendered.length) ? source.length : i;
}

/**
 * The cursor position for a click on Obsidian's rendered callout: `offset`
 * characters into the rendered title or body text.
 */
export function calloutClickPos(
	c: Callout,
	area: 'title' | 'body',
	rendered: string,
	offset: number,
	slice: (from: number, to: number) => string,
): number {
	if (area === 'title' || c.body.length === 0) {
		const source = slice(c.title.from, c.title.to);
		return c.title.from + (area === 'title' ? alignOffset(rendered, source, offset) : source.length);
	}
	// The body as one text, lines joined by "\n", with each character's position.
	const positions: number[] = [];
	let source = '';
	c.body.forEach((line, n) => {
		if (n > 0) {
			positions.push(line.lineFrom - 1);
			source += '\n';
		}
		for (let p = line.to; p < line.lineTo; p++) positions.push(p);
		source += slice(line.to, line.lineTo);
	});
	const i = alignOffset(rendered, source, offset);
	const last = c.body[c.body.length - 1]!;
	return i < positions.length ? positions[i]! : last.lineTo;
}

export type BodyLineKind = 'blank' | 'text' | 'list';

export interface LineSpacing {
	/** Paragraph or list spacing above (a block starts right after another). */
	blockTop: boolean;
	/** Paragraph or list spacing below (the last block of the callout). */
	blockBottom: boolean;
	/** List item spacing above and below. */
	itemTop: boolean;
	itemBottom: boolean;
	/** An empty line between blocks: one spacing tall. */
	gap: boolean;
}

/**
 * Vertical spacing of callout body lines, so the callout keeps the same
 * layout as Obsidian's rendered one when the cursor enters it. Rendered
 * paragraphs and lists have --p-spacing above and below (shared between
 * two blocks), and each list item has --list-spacing above and below.
 *
 * Blocks are runs of non-empty lines. A list right after text starts a new
 * block (a list can interrupt a paragraph); text right after a list item
 * continues that item. An empty line between blocks supplies the shared
 * spacing itself.
 */
export function calloutLineSpacing(kinds: readonly BodyLineKind[]): LineSpacing[] {
	const out: LineSpacing[] = kinds.map(() => ({
		blockTop: false,
		blockBottom: false,
		itemTop: false,
		itemBottom: false,
		gap: false,
	}));
	let blockStart = -1;
	let blockIsList = false;
	let itemStart = -1;
	const closeItem = (end: number) => {
		if (itemStart >= 0) {
			out[itemStart]!.itemTop = true;
			out[end]!.itemBottom = true;
		}
		itemStart = -1;
	};
	kinds.forEach((kind, i) => {
		const prev = i > 0 ? kinds[i - 1]! : null;
		if (kind === 'blank') {
			out[i]!.gap = true;
			if (prev && prev !== 'blank') closeItem(i - 1);
			blockStart = -1;
			return;
		}
		const newBlock = blockStart < 0 || (kind === 'list' && !blockIsList);
		if (kind === 'list' && prev && prev !== 'blank') closeItem(i - 1);
		if (newBlock) {
			blockStart = i;
			blockIsList = kind === 'list';
			// After an empty line, that line is the spacing.
			if (prev !== 'blank') out[i]!.blockTop = true;
		}
		if (kind === 'list') itemStart = i;
	});
	const last = kinds.length - 1;
	if (last >= 0 && kinds[last] !== 'blank') {
		closeItem(last);
		out[last]!.blockBottom = true;
	}
	return out;
}
