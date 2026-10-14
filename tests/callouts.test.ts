import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	alignOffset,
	calloutBackspace,
	calloutClickPos,
	calloutDelete,
	calloutIcon,
	calloutMarkers,
	calloutTitlePlaceholder,
	parseCallouts,
	planCalloutType,
	planFoldToggle,
} from '../src/callouts.ts';
import type { LineInfo } from '../src/fences.ts';

function lines(doc: string): LineInfo[] {
	const out: LineInfo[] = [];
	let from = 0;
	for (const text of doc.split('\n')) {
		out.push({ from, text });
		from += text.length + 1;
	}
	return out;
}

// "a\n> [!tip]+ Title\n> body\nb"
//  0 2          12   18 20   25
const DOC = 'a\n> [!tip]+ Title\n> body\nb';
const [C] = parseCallouts(lines(DOC));

test('finds a callout: type, fold sign, title and body lines', () => {
	assert.deepEqual(C, {
		type: 'tip',
		typeRange: { from: 6, to: 9 },
		fold: '+',
		foldRange: { from: 10, to: 11 },
		header: { lineFrom: 2, from: 2, to: 12, lineTo: 17 },
		title: { from: 12, to: 17 },
		body: [{ lineFrom: 18, from: 18, to: 20, lineTo: 24, blank: false }],
		from: 2,
		to: 24,
		empty: false,
	});
});

test('no fold sign, no title, and ">" lines with no space', () => {
	const [c] = parseCallouts(lines('>[!note]\n>'));
	assert.equal(c?.fold, '');
	assert.deepEqual(c?.foldRange, { from: 8, to: 8 });
	assert.deepEqual(c?.title, { from: 8, to: 8 });
	assert.deepEqual(c?.body, [{ lineFrom: 9, from: 9, to: 10, lineTo: 10, blank: true }]);
	assert.equal(c?.empty, true);
});

test('a callout ends at the first line that is not a quote', () => {
	const cs = parseCallouts(lines('> [!note]\n> a\n\n> [!info] B\n> b'));
	assert.deepEqual(
		cs.map((c) => [c.type, c.body.length]),
		[
			['note', 1],
			['info', 1],
		],
	);
});

test('a header-like line inside a callout is body text', () => {
	const cs = parseCallouts(lines('> [!note] A\n> [!info] B'));
	assert.equal(cs.length, 1);
	assert.equal(cs[0]!.body.length, 1);
});

test('plain quotes are not callouts, and nested callouts are skipped', () => {
	assert.deepEqual(parseCallouts(lines('> just a quote\n> more')), []);
	assert.deepEqual(parseCallouts(lines('> [!note] Outer\n> > [!tip] Inner\n> > x')), []);
	assert.deepEqual(parseCallouts(lines('> [!note] Outer\n>> deeper')), []);
});

test('the hidden markers are like block markers', () => {
	assert.deepEqual(calloutMarkers([C!]), [
		{ lineFrom: 2, from: 2, to: 12 },
		{ lineFrom: 18, from: 18, to: 20 },
	]);
});

test('Backspace at the start of an empty callout turns it into plain text', () => {
	// "a\n> [!note]\n> \nb": header 2..11 (title starts at 11), body "> " 12..14.
	const doc = 'a\n> [!note]\n> \nb';
	const [c] = parseCallouts(lines(doc));
	assert.deepEqual(calloutBackspace(11, [c!]), { from: 2, to: 14, cursor: 2 });
	// From the start of the line too.
	assert.deepEqual(calloutBackspace(2, [c!]), { from: 2, to: 14, cursor: 2 });
});

test('Backspace at the start of a non-empty title does nothing', () => {
	assert.deepEqual(calloutBackspace(12, [C!]), { from: 12, to: 12, cursor: 12 });
});

test('Backspace at the start of a body line joins it to the line above', () => {
	assert.deepEqual(calloutBackspace(20, [C!]), { from: 17, to: 20, cursor: 17 });
	assert.equal(calloutBackspace(22, [C!]), null);
});

test('Delete at the end of the line above a callout does nothing', () => {
	assert.equal(calloutDelete(1, [C!]), true);
	assert.equal(calloutDelete(15, [C!]), false);
});

test('changing the type and folding', () => {
	assert.deepEqual(planCalloutType(C!, 'warning'), { from: 6, to: 9, insert: 'warning' });
	assert.deepEqual(planCalloutType(C!, ''), { from: 6, to: 9, insert: 'note' });
	assert.deepEqual(planFoldToggle(C!), { from: 10, to: 11, insert: '-' });
	const [plain] = parseCallouts(lines('> [!note] x'));
	assert.equal(planFoldToggle(plain!), null);
});

test('icons and empty titles follow Obsidian', () => {
	assert.equal(calloutIcon('warning'), 'lucide-alert-triangle');
	assert.equal(calloutIcon('Caution'), 'lucide-alert-triangle');
	assert.equal(calloutIcon('my-custom'), 'lucide-pencil');
	assert.equal(calloutTitlePlaceholder('tip'), 'Tip');
	assert.equal(calloutTitlePlaceholder('NOTE'), 'Note');
});

test('alignOffset maps rendered text to markdown source, skipping markup', () => {
	// "a **bold** word" renders as "a bold word".
	assert.equal(alignOffset('a bold word', 'a **bold** word', 0), 0);
	assert.equal(alignOffset('a bold word', 'a **bold** word', 3), 5);
	assert.equal(alignOffset('a bold word', 'a **bold** word', 6), 8);
	assert.equal(alignOffset('a bold word', 'a **bold** word', 11), 15);
	// Extra spaces in the rendered text are skipped.
	assert.equal(alignOffset('one\n\ntwo', 'one\ntwo', 6), 5);
	// Past the end: the end of the source.
	assert.equal(alignOffset('ab', 'ab', 9), 2);
});

test('a click on the rendered title or body lands at the same spot in the source', () => {
	const doc = '> [!tip] My **title**\n> first line\n> second';
	const [c] = parseCallouts(lines(doc));
	const slice = (a: number, b: number) => doc.slice(a, b);
	// Title "My title": 3 characters in is right after "My " (before the
	// hidden "**", the same spot on screen).
	assert.equal(calloutClickPos(c!, 'title', 'My title', 3, slice), doc.indexOf('**title'));
	// Body "first line\nsecond": 2 characters in is after "fi".
	assert.equal(calloutClickPos(c!, 'body', 'first line\nsecond', 2, slice), doc.indexOf('rst line'));
	// 13 characters in is after "se" on the second line.
	assert.equal(calloutClickPos(c!, 'body', 'first line\nsecond', 13, slice), doc.indexOf('cond'));
	// No body: the end of the title.
	const [t] = parseCallouts(lines('> [!note] T'));
	assert.equal(calloutClickPos(t!, 'body', '', 0, (a, b) => '> [!note] T'.slice(a, b)), 11);
});
