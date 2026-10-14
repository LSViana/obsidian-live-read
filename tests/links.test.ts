import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Token, computeHidden, insertPosition } from '../src/hidden-ranges.ts';
import {
	buildLink,
	cleanTarget,
	isLinkToken,
	linkAt,
	looksLikeUrl,
	parseLinks,
	planLinkEdit,
} from '../src/links.ts';

// Obsidian node names for link parts (classes joined by "_").
const MD_BRACKET = 'formatting_formatting-link_link';
const MD_PAREN = 'formatting_formatting-link-string_string_url';
const WIKI_START = 'formatting-link_formatting-link-start';
const WIKI_EMBED_START = 'formatting-link_formatting-link-start_formatting-embed';
const WIKI_TARGET = 'hmd-internal-link';
const WIKI_TARGET_ALIASED = 'hmd-internal-link_link-has-alias';
const WIKI_PIPE = 'hmd-internal-link_link-alias-pipe';
const WIKI_ALIAS = 'hmd-internal-link_link-alias';
const WIKI_END = 'formatting-link_formatting-link-end';
const EMBED_TARGET = 'hmd-internal-link_hmd-embed';
const FOOTREF_START = 'formatting_formatting-link_formatting-link-start';

/** Tokens at fixed [from, to, name] spots. */
const t = (from: number, to: number, name: string): Token => ({ from, to, name });

// "[text](http://x.io) after"
//  0    5 6            19
const MD = [t(0, 1, MD_BRACKET), t(5, 6, MD_BRACKET), t(6, 7, MD_PAREN), t(18, 19, MD_PAREN)];
// "[[note]] x"
const WIKI = [t(0, 2, WIKI_START), t(2, 6, WIKI_TARGET), t(6, 8, WIKI_END)];
// "[[note|alias]] x"
const ALIAS = [
	t(0, 2, WIKI_START),
	t(2, 6, WIKI_TARGET_ALIASED),
	t(6, 7, WIKI_PIPE),
	t(7, 12, WIKI_ALIAS),
	t(12, 14, WIKI_END),
];

test('isLinkToken picks link parts only', () => {
	for (const name of [MD_BRACKET, MD_PAREN, WIKI_START, WIKI_TARGET, WIKI_PIPE, WIKI_ALIAS, WIKI_END]) {
		assert.equal(isLinkToken(name), true, name);
	}
	assert.equal(isLinkToken('formatting_formatting-strong_strong'), false);
	assert.equal(isLinkToken('link'), false);
	assert.equal(isLinkToken('string_url'), false);
});

test('parses a markdown link', () => {
	assert.deepEqual(parseLinks(MD), [
		{
			kind: 'markdown',
			from: 0,
			to: 19,
			text: { from: 1, to: 5 },
			target: { from: 7, to: 18 },
			open: { from: 0, to: 1 },
			close: { from: 5, to: 19 },
		},
	]);
});

test('parses a wikilink, showing the note name', () => {
	assert.deepEqual(parseLinks(WIKI), [
		{
			kind: 'wiki',
			from: 0,
			to: 8,
			text: { from: 2, to: 6 },
			target: { from: 2, to: 6 },
			open: { from: 0, to: 2 },
			close: { from: 6, to: 8 },
		},
	]);
});

test('parses a wikilink with an alias, showing the alias', () => {
	assert.deepEqual(parseLinks(ALIAS), [
		{
			kind: 'wiki',
			from: 0,
			to: 14,
			text: { from: 7, to: 12 },
			target: { from: 2, to: 6 },
			open: { from: 0, to: 7 },
			close: { from: 12, to: 14 },
		},
	]);
});

test('skips embeds, images, footnotes and unfinished links', () => {
	// ![[pic.png]]
	assert.deepEqual(parseLinks([t(0, 3, WIKI_EMBED_START), t(3, 10, EMBED_TARGET), t(10, 12, WIKI_END)]), []);
	// ![alt](a.png): every part carries "image"
	assert.deepEqual(
		parseLinks([
			t(1, 2, `${MD_BRACKET}_image`),
			t(5, 6, `${MD_BRACKET}_image`),
			t(6, 7, `${MD_PAREN}_image`),
			t(12, 13, `${MD_PAREN}_image`),
		]),
		[],
	);
	// [^1]
	assert.deepEqual(parseLinks([t(0, 2, FOOTREF_START), t(2, 3, 'footref'), t(3, 4, 'formatting_footref')]), []);
	// [text] with no (url), and [[note without the end
	assert.deepEqual(parseLinks([t(0, 1, MD_BRACKET), t(5, 6, MD_BRACKET)]), []);
	assert.deepEqual(parseLinks([t(0, 2, WIKI_START), t(2, 6, WIKI_TARGET)]), []);
});

test('finds several links on one line', () => {
	const shifted = WIKI.map((x) => t(x.from + 20, x.to + 20, x.name));
	const links = parseLinks([...MD, ...shifted]);
	assert.deepEqual(
		links.map((l) => [l.kind, l.from, l.to]),
		[
			['markdown', 0, 19],
			['wiki', 20, 28],
		],
	);
});

test('computeHidden hides the link parts around the text', () => {
	assert.deepEqual(computeHidden([MD]).hidden, [
		{ from: 0, to: 1 },
		{ from: 5, to: 19 },
	]);
	assert.deepEqual(computeHidden([ALIAS]).hidden, [
		{ from: 0, to: 7 },
		{ from: 12, to: 14 },
	]);
	assert.deepEqual(computeHidden([MD]).linkEnds, [{ from: 5, to: 19 }]);
});

test('typing at either edge of a link goes outside it', () => {
	const { hidden, linkEnds } = computeHidden([MD]);
	// End of the text (before "](...)") and after the link: both go after it.
	assert.equal(insertPosition(5, hidden, linkEnds), 19);
	assert.equal(insertPosition(19, hidden, linkEnds), 19);
	// Start of the text: before "[".
	assert.equal(insertPosition(1, hidden, linkEnds), 0);
	// Middle: unchanged.
	assert.equal(insertPosition(3, hidden, linkEnds), 3);
});

test('a bold link: typing at the end stays bold but outside the link', () => {
	// "**[ab](u)**": ** 0..2, [ 2..3, ab 3..5, ](u) 5..9, ** 9..11
	const tokens = [
		t(0, 2, 'formatting_formatting-strong_strong'),
		t(2, 3, `${MD_BRACKET}_strong`),
		t(5, 6, `${MD_BRACKET}_strong`),
		t(6, 7, `${MD_PAREN}_strong`),
		t(8, 9, `${MD_PAREN}_strong`),
		t(9, 11, 'formatting_formatting-strong_strong'),
	];
	const { hidden, linkEnds } = computeHidden([tokens]);
	assert.equal(insertPosition(5, hidden, linkEnds), 9);
	assert.equal(insertPosition(11, hidden, linkEnds), 9);
});

test('linkAt finds the link under the cursor, edges included', () => {
	const links = parseLinks(MD);
	assert.equal(linkAt(0, links)?.from, 0);
	assert.equal(linkAt(3, links)?.from, 0);
	assert.equal(linkAt(19, links)?.from, 0);
	assert.equal(linkAt(20, links), undefined);
});

test('looksLikeUrl tells web addresses from note names', () => {
	assert.equal(looksLikeUrl('https://obsidian.md'), true);
	assert.equal(looksLikeUrl('mailto:a@b.c'), true);
	assert.equal(looksLikeUrl('www.example.com'), true);
	assert.equal(looksLikeUrl('My note'), false);
	assert.equal(looksLikeUrl('Folder/Note#Heading'), false);
});

test('cleanTarget removes <...> around markdown targets', () => {
	assert.equal(cleanTarget('markdown', '<a b.md>'), 'a b.md');
	assert.equal(cleanTarget('markdown', 'http://x'), 'http://x');
	assert.equal(cleanTarget('wiki', '<x>'), '<x>');
});

test('buildLink writes markdown and wiki links', () => {
	assert.equal(buildLink('markdown', 'text', 'http://x.io'), '[text](http://x.io)');
	assert.equal(buildLink('markdown', 'a [b]', 'u'), '[a \\[b\\]](u)');
	assert.equal(buildLink('markdown', 'doc', 'my file.pdf'), '[doc](<my file.pdf>)');
	assert.equal(buildLink('markdown', '', 'http://x.io'), '[http://x.io](http://x.io)');
	assert.equal(buildLink('wiki', 'Note', 'Note'), '[[Note]]');
	assert.equal(buildLink('wiki', '', 'Note'), '[[Note]]');
	assert.equal(buildLink('wiki', 'see this', 'Note'), '[[Note|see this]]');
});

test('editing a link keeps its kind and puts the cursor after it', () => {
	const [md] = parseLinks(MD);
	assert.deepEqual(planLinkEdit(md!, { from: 0, to: 19 }, 'new', 'https://y.io'), {
		from: 0,
		to: 19,
		insert: '[new](https://y.io)',
		cursor: 19,
	});
	const [wiki] = parseLinks(WIKI);
	assert.deepEqual(planLinkEdit(wiki!, { from: 0, to: 8 }, 'shown', 'Other'), {
		from: 0,
		to: 8,
		insert: '[[Other|shown]]',
		cursor: 15,
	});
});

test('an empty target removes the link and keeps its text', () => {
	const [md] = parseLinks(MD);
	assert.deepEqual(planLinkEdit(md!, { from: 0, to: 19 }, 'text', '  '), {
		from: 0,
		to: 19,
		insert: 'text',
		cursor: 4,
	});
});

test('creating a link picks markdown for URLs and wiki for note names', () => {
	assert.deepEqual(planLinkEdit(null, { from: 2, to: 6 }, 'word', 'https://x.io'), {
		from: 2,
		to: 6,
		insert: '[word](https://x.io)',
		cursor: 22,
	});
	assert.deepEqual(planLinkEdit(null, { from: 2, to: 6 }, 'word', 'Some note'), {
		from: 2,
		to: 6,
		insert: '[[Some note|word]]',
		cursor: 20,
	});
	assert.equal(planLinkEdit(null, { from: 2, to: 2 }, 'x', ''), null);
});

test('a picked note forces a wikilink, also when editing a markdown link', () => {
	const [md] = parseLinks(MD);
	assert.equal(planLinkEdit(md!, { from: 0, to: 19 }, 'text', 'Card 7', 'wiki')?.insert, '[[Card 7|text]]');
	assert.equal(planLinkEdit(null, { from: 0, to: 0 }, 'Card 7', 'Card 7', 'wiki')?.insert, '[[Card 7]]');
	assert.equal(planLinkEdit(null, { from: 0, to: 0 }, 'Roadmap', 'Project plan', 'wiki')?.insert, '[[Project plan|Roadmap]]');
});
