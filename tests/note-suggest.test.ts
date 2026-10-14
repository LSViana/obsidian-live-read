import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Fuzzy, type NoteEntry, rankNotes, textForPick } from '../src/note-suggest.ts';

/** A small stand-in for Obsidian's fuzzy search: letters in order, fewer gaps score higher. */
export const fuzzy: Fuzzy = (query) => {
	const q = query.toLowerCase().replace(/\s+/g, '');
	return (text) => {
		const t = text.toLowerCase();
		let at = -1;
		let gaps = 0;
		for (const ch of q) {
			const i = t.indexOf(ch, at + 1);
			if (i < 0) return null;
			if (at >= 0) gaps += i - at - 1;
			at = i;
		}
		return { score: -gaps - t.length / 100 };
	};
};

const note = (name: string, aliases: string[] = [], folder = ''): NoteEntry => ({
	path: `${folder}${name}.md`,
	name,
	linktext: name,
	aliases,
});

const NOTES = [
	note('Card 3', [], 'Cards/'),
	note('Card 7', ['Seventh card'], 'Cards/'),
	note('Board #1', [], 'Boards/'),
	note('Live Read test'),
	note('Project plan', ['Roadmap', 'Plan for 2026']),
];

test('matches note names fuzzily, best first', () => {
	const r = rankNotes('crd', NOTES, fuzzy);
	assert.deepEqual(
		r.map((s) => s.label),
		['Card 3', 'Card 7', 'Seventh card'],
	);
});

test('matches aliases and says which note they belong to', () => {
	const [first] = rankNotes('roadmap', NOTES, fuzzy);
	assert.equal(first?.alias, 'Roadmap');
	assert.equal(first?.entry.name, 'Project plan');
	const seventh = rankNotes('seventh', NOTES, fuzzy);
	assert.deepEqual(
		seventh.map((s) => [s.label, s.entry.name]),
		[['Seventh card', 'Card 7']],
	);
});

test('a note can match by name and by alias', () => {
	const r = rankNotes('plan', NOTES, fuzzy);
	assert.deepEqual(r.map((s) => s.label).sort(), ['Plan for 2026', 'Project plan']);
	assert.ok(r.every((s) => s.entry.name === 'Project plan'));
});

test('no suggestions for an empty query or a web address', () => {
	assert.deepEqual(rankNotes('', NOTES, fuzzy), []);
	assert.deepEqual(rankNotes('   ', NOTES, fuzzy), []);
	assert.deepEqual(rankNotes('https://obsidian.md', NOTES, fuzzy), []);
	assert.deepEqual(rankNotes('www.card.com', NOTES, fuzzy), []);
});

test('the list is capped', () => {
	const many = Array.from({ length: 80 }, (_, i) => note(`Note ${i}`));
	assert.equal(rankNotes('note', many, fuzzy).length, 50);
	assert.equal(rankNotes('note', many, fuzzy, 5).length, 5);
});

const card7 = rankNotes('card 7', NOTES, fuzzy)[0]!;
const alias = rankNotes('seventh', NOTES, fuzzy)[0]!;

test('picking fills an empty Text field: note name, or the alias', () => {
	assert.equal(textForPick('', [], card7), 'Card 7');
	assert.equal(textForPick('', [], alias), 'Seventh card');
});

test('picking replaces Text that still holds the old note name', () => {
	// Editing [[Card 3]]: Text starts as "Card 3", same as the old target.
	assert.equal(textForPick('Card 3', ['Card 3'], alias), 'Seventh card');
	assert.equal(textForPick('Card 3', ['Card 3'], card7), 'Card 7');
	// Picking again replaces what the first pick put there.
	assert.equal(textForPick('Seventh card', ['Card 3', 'Seventh card'], card7), 'Card 7');
});

test('picking never overwrites text the user typed or selected', () => {
	assert.equal(textForPick('my words', ['Card 3'], alias), null);
	assert.equal(textForPick('my words', [], card7), null);
});
