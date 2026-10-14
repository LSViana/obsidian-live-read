import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockToken, parseBlock } from '../src/blocks.ts';
import {
	type Token,
	backspaceRange,
	deleteForwardRange,
	insertPosition,
	skipBlock,
} from '../src/hidden-ranges.ts';

const t = (from: number, to: number, name: string): Token => ({ from, to, name });

const H1 = 'formatting_formatting-header_formatting-header-1_header_header-1';
const H2 = 'formatting_formatting-header_formatting-header-2_header_header-2';
const UL = 'formatting_formatting-list_formatting-list-ul_list-1';
const OL = 'formatting_formatting-list_formatting-list-ol_list-1';
const TASK = 'formatting_formatting-task_meta';
const Q1 = 'formatting_formatting-quote_formatting-quote-1_quote_quote-1';
const Q2 = 'formatting_formatting-quote_formatting-quote-2_quote_quote-2';

const prev = (p: number) => p - 1;
const next = (p: number) => p + 1;

test('isBlockToken picks block markers only', () => {
	for (const name of [H1, UL, OL, TASK, Q1]) assert.equal(isBlockToken(name), true, name);
	assert.equal(isBlockToken('formatting_formatting-strong_strong'), false);
	assert.equal(isBlockToken('header_header-1'), false);
	assert.equal(isBlockToken('list-1'), false);
});

test('a heading marker, with the text starting right after it', () => {
	assert.deepEqual(parseBlock(0, '## Title', [t(0, 3, H2)]), {
		lineFrom: 0,
		from: 0,
		to: 3,
		parts: [{ kind: 'heading', from: 0, to: 3 }],
	});
});

test('a heading with no text yet keeps its # visible', () => {
	assert.equal(parseBlock(0, '# ', [t(0, 2, H1)]), null);
	assert.equal(parseBlock(0, '#', [t(0, 1, H1)]), null);
});

test('bullets and numbers', () => {
	assert.deepEqual(parseBlock(10, '- item', [t(10, 12, UL)])?.parts, [{ kind: 'bullet', from: 10, to: 12 }]);
	assert.deepEqual(parseBlock(0, '12. item', [t(0, 4, OL)]), {
		lineFrom: 0,
		from: 0,
		to: 4,
		parts: [{ kind: 'number', from: 0, to: 4 }],
	});
});

test('an empty list item is still a block, so its bullet shows', () => {
	assert.deepEqual(parseBlock(0, '- ', [t(0, 2, UL)])?.to, 2);
});

test('a checkbox item covers the space after the box', () => {
	assert.deepEqual(parseBlock(0, '- [x] done', [t(0, 2, UL), t(2, 5, TASK)]), {
		lineFrom: 0,
		from: 0,
		to: 6,
		parts: [
			{ kind: 'bullet', from: 0, to: 2 },
			{ kind: 'task', from: 2, to: 5, task: 'x' },
		],
	});
});

test('quotes, nested quotes and a list inside a quote', () => {
	assert.deepEqual(parseBlock(0, '> text', [t(0, 2, Q1)])?.parts, [
		{ kind: 'quote', from: 0, to: 2, firstLevel: true },
	]);
	assert.deepEqual(
		parseBlock(0, '>> deep', [t(0, 1, Q1), t(1, 3, Q2)])?.parts.map((p) => [p.kind, p.firstLevel]),
		[
			['quote', true],
			['quote', false],
		],
	);
	assert.deepEqual(parseBlock(0, '> - item', [t(0, 2, Q1), t(2, 4, UL)])?.to, 4);
});

test('an indented item starts after the indentation', () => {
	assert.deepEqual(parseBlock(0, '\t- item', [t(1, 3, UL)]), {
		lineFrom: 0,
		from: 1,
		to: 3,
		parts: [{ kind: 'bullet', from: 1, to: 3 }],
	});
});

test('markers after text are not blocks', () => {
	assert.equal(parseBlock(0, 'a - b', [t(2, 4, UL)]), null);
	assert.equal(parseBlock(0, 'plain', []), null);
});

// "x\n- ab": line 2 starts at 2, its marker is 2..4, text "ab" is 4..6.
const ITEM = { lineFrom: 2, from: 2, to: 4 };

test('typing at the line start goes after the marker', () => {
	assert.equal(insertPosition(2, [], [ITEM]), 4);
	assert.equal(insertPosition(3, [], [ITEM]), 4);
	assert.equal(insertPosition(4, [], [ITEM]), 4);
	assert.equal(insertPosition(5, [], [ITEM]), 5);
});

test('arrow keys never stop inside or before a bullet', () => {
	// Right from the end of the line above lands at 2: jump to the text.
	assert.equal(skipBlock(2, [ITEM], true), 4);
	// Left from the text start lands at 3: go to the end of the line above.
	assert.equal(skipBlock(3, [ITEM], false), 1);
	// On the first line there is no line above: stop at the line start.
	assert.equal(skipBlock(1, [{ lineFrom: 0, from: 0, to: 2 }], false), 0);
	// An indented item stops before its bullet.
	assert.equal(skipBlock(4, [{ lineFrom: 2, from: 3, to: 5 }], false), 3);
	// Outside any block: unchanged.
	assert.equal(skipBlock(5, [ITEM], true), 5);
});

test('Backspace at the start of the item text removes the marker', () => {
	assert.deepEqual(backspaceRange(4, [], [], prev, [ITEM]), { from: 2, to: 4 });
	// Also from the line start (before the bullet).
	assert.deepEqual(backspaceRange(2, [], [], prev, [ITEM]), { from: 2, to: 4 });
	// Indentation goes too, so the line becomes plain text.
	assert.deepEqual(backspaceRange(5, [], [], prev, [{ lineFrom: 2, from: 3, to: 5 }]), { from: 2, to: 5 });
	// In the middle of the text: left to the editor.
	assert.equal(backspaceRange(5, [], [], prev, [ITEM]), null);
});

test('Backspace at the start of bold text in a list item removes the bullet, not the stars', () => {
	// "- **b**": bullet 0..2, ** 2..4, b 4..5, ** 5..7. The text starts at 4.
	const hidden = [
		{ from: 2, to: 4 },
		{ from: 5, to: 7 },
	];
	assert.deepEqual(backspaceRange(4, hidden, [], prev, [{ lineFrom: 0, from: 0, to: 2 }]), { from: 0, to: 2 });
});

test('Delete at the end of a line joins the next item text without its marker', () => {
	assert.deepEqual(deleteForwardRange(1, [], [], 6, next, [ITEM]), { from: 1, to: 4 });
	assert.equal(deleteForwardRange(0, [], [], 6, next, [ITEM]), null);
});
