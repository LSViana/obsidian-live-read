// Pure logic for links: [text](url), [[note]] and [[note|alias]]. No Obsidian
// or CodeMirror imports, so it can be unit tested with plain Node.
import type { Range, Token } from './hidden-ranges.ts';

export type LinkKind = 'markdown' | 'wiki';

export interface LinkSpan {
	kind: LinkKind;
	/** The whole link source, from `[` to `)` or `]]`. */
	from: number;
	to: number;
	/** The part shown on screen. */
	text: Range;
	/** The url or note name. */
	target: Range;
	/** Hidden parts before and after the visible text. */
	open: Range;
	close: Range;
}

function classesOf(name: string): Set<string> {
	return new Set(name.split(/[_\s]+/));
}

/** True for tokens that may belong to a link, so the editor collects them. */
export function isLinkToken(name: string): boolean {
	const c = classesOf(name);
	return (
		c.has('formatting-link') ||
		c.has('formatting-link-string') ||
		c.has('hmd-internal-link') ||
		c.has('link-alias-pipe')
	);
}

/**
 * Finds complete links in the tokens of one line. Embeds (`![[...]]`),
 * images (`![alt](src)`), footnotes and links without a target are skipped.
 */
export function parseLinks(lineTokens: Token[]): LinkSpan[] {
	const tokens = [...lineTokens].sort((a, b) => a.from - b.from);
	const links: LinkSpan[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]!;
		const c = classesOf(t.name);
		if (c.has('formatting-link-start')) {
			const wiki = parseWiki(tokens, i);
			if (wiki) {
				links.push(wiki.link);
				i = wiki.end;
			}
		} else if (c.has('formatting-link') && c.has('link') && !c.has('url') && !c.has('image')) {
			const md = parseMarkdown(tokens, i);
			if (md) {
				links.push(md.link);
				i = md.end;
			}
		}
	}
	return links;
}

function parseWiki(tokens: Token[], start: number): { link: LinkSpan; end: number } | null {
	const open = tokens[start]!;
	if (classesOf(open.name).has('formatting-embed')) return null;
	const first = tokens[start + 1];
	if (!first || !classesOf(first.name).has('hmd-internal-link')) return null;
	let pipe: Token | null = null;
	for (let j = start + 1; j < tokens.length; j++) {
		const t = tokens[j]!;
		const c = classesOf(t.name);
		if (c.has('hmd-embed')) return null;
		if (c.has('link-alias-pipe')) pipe = t;
		if (c.has('formatting-link-end')) {
			const target = { from: open.to, to: pipe ? pipe.from : t.from };
			const text = pipe ? { from: pipe.to, to: t.from } : target;
			if (target.to <= target.from || text.to <= text.from) return null;
			return {
				link: {
					kind: 'wiki',
					from: open.from,
					to: t.to,
					text,
					target,
					open: { from: open.from, to: text.from },
					close: { from: t.from, to: t.to },
				},
				end: j,
			};
		}
		if (!c.has('hmd-internal-link') && !c.has('link-alias-pipe')) return null;
	}
	return null;
}

function parseMarkdown(tokens: Token[], start: number): { link: LinkSpan; end: number } | null {
	const open = tokens[start]!;
	if (open.to - open.from !== 1) return null;
	// Find "]" then "(" right after it, then ")".
	let j = start + 1;
	let closeBracket: Token | null = null;
	for (; j < tokens.length; j++) {
		const c = classesOf(tokens[j]!.name);
		if (c.has('formatting-link') && c.has('link') && !c.has('url')) {
			closeBracket = tokens[j]!;
			break;
		}
	}
	if (!closeBracket || closeBracket.to - closeBracket.from !== 1) return null;
	const paren = tokens[j + 1];
	if (!paren || paren.from !== closeBracket.to || !classesOf(paren.name).has('formatting-link-string')) {
		return null;
	}
	for (let k = j + 2; k < tokens.length; k++) {
		const t = tokens[k]!;
		const c = classesOf(t.name);
		if (c.has('formatting-link-string')) {
			const text = { from: open.to, to: closeBracket.from };
			if (text.to <= text.from) return null;
			return {
				link: {
					kind: 'markdown',
					from: open.from,
					to: t.to,
					text,
					target: { from: paren.to, to: t.from },
					open: { from: open.from, to: open.to },
					close: { from: closeBracket.from, to: t.to },
				},
				end: k,
			};
		}
	}
	return null;
}

/** The link the cursor is on (edges included), if any. */
export function linkAt(pos: number, links: readonly LinkSpan[]): LinkSpan | undefined {
	return links.find((l) => l.from <= pos && pos <= l.to);
}

/** True when a target looks like a web address or other URL. */
export function looksLikeUrl(target: string): boolean {
	return /^[a-z][a-z0-9+.-]*:/i.test(target) || /^www\./i.test(target);
}

/** Reads a markdown link target, removing `<...>` around it. */
export function cleanTarget(kind: LinkKind, raw: string): string {
	const t = raw.trim();
	return kind === 'markdown' && t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1) : t;
}

/** Writes link source. Empty text uses the target as text. */
export function buildLink(kind: LinkKind, text: string, target: string): string {
	const shown = text.length ? text : target;
	if (kind === 'wiki') return shown === target ? `[[${target}]]` : `[[${target}|${shown}]]`;
	const safeText = shown.replace(/([[\]])/g, '\\$1');
	const safeTarget = /[\s()<>]/.test(target) ? `<${target}>` : target;
	return `[${safeText}](${safeTarget})`;
}

export interface LinkEdit {
	from: number;
	to: number;
	insert: string;
	/** Cursor after the edit: right after the link (or the plain text). */
	cursor: number;
}

/**
 * The edit for the link popup.
 * - Editing a link keeps its kind. An empty target removes the link and
 *   keeps its text.
 * - Creating a link replaces `range` (the selection, maybe empty). The kind
 *   is markdown for URLs and wiki for note names. An empty target does
 *   nothing.
 */
export function planLinkEdit(
	existing: LinkSpan | null,
	range: Range,
	text: string,
	target: string,
): LinkEdit | null {
	const goal = target.trim();
	if (existing) {
		const insert = goal ? buildLink(existing.kind, text, goal) : text;
		return { from: existing.from, to: existing.to, insert, cursor: existing.from + insert.length };
	}
	if (!goal) return null;
	const insert = buildLink(looksLikeUrl(goal) ? 'markdown' : 'wiki', text, goal);
	return { from: range.from, to: range.to, insert, cursor: range.from + insert.length };
}
