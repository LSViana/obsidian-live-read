// Pure logic for note suggestions in the link popup. The fuzzy matcher is
// passed in (Obsidian's prepareFuzzySearch in the plugin, a simple one in
// tests), so this file has no Obsidian imports.
import { looksLikeUrl } from './links.ts';

export interface NoteEntry {
	path: string;
	/** File name without extension. */
	name: string;
	/** Shortest link text that points to this note. */
	linktext: string;
	/** Frontmatter aliases. */
	aliases: string[];
}

export interface FuzzyResult {
	score: number;
}

export type Fuzzy<R extends FuzzyResult = FuzzyResult> = (query: string) => (text: string) => R | null;

export interface NoteSuggestion<R extends FuzzyResult = FuzzyResult> {
	entry: NoteEntry;
	/** Set when the match is on an alias. */
	alias: string | null;
	/** What was matched and is shown: the note name or the alias. */
	label: string;
	match: R;
}

/**
 * Notes matching what was typed in "Link to", by name and by alias, best
 * first. Nothing for an empty query or a web address.
 */
export function rankNotes<R extends FuzzyResult>(
	query: string,
	entries: readonly NoteEntry[],
	fuzzy: Fuzzy<R>,
	limit = 50,
): NoteSuggestion<R>[] {
	const q = query.trim();
	if (!q || looksLikeUrl(q)) return [];
	const test = fuzzy(q);
	const out: NoteSuggestion<R>[] = [];
	for (const entry of entries) {
		const byName = test(entry.name);
		if (byName) out.push({ entry, alias: null, label: entry.name, match: byName });
		for (const alias of entry.aliases) {
			const byAlias = test(alias);
			if (byAlias) out.push({ entry, alias, label: alias, match: byAlias });
		}
	}
	out.sort(
		(a, b) =>
			b.match.score - a.match.score ||
			a.label.length - b.label.length ||
			a.label.localeCompare(b.label),
	);
	return out.slice(0, limit);
}

/**
 * The new "Text" after picking a suggestion, or null to keep what is there.
 * The text is only replaced while it is empty or still one of the values
 * the popup filled in itself (`untouched`), so words the user typed or
 * selected are never overwritten. Picking an alias shows the alias.
 */
export function textForPick(current: string, untouched: readonly string[], pick: NoteSuggestion): string | null {
	if (current.trim() !== '' && !untouched.includes(current)) return null;
	return pick.alias ?? pick.entry.linktext;
}
