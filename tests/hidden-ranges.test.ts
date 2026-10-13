import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	type Token,
	backspaceRange,
	computeHidden,
	deleteForwardRange,
	insertPosition,
	markerKinds,
	mergeRanges,
	skipHiddenEdge,
} from '../src/hidden-ranges.ts';

// Node names follow Obsidian's editor syntax tree: classes joined by "_".
const STRONG = 'formatting_formatting-strong_strong';
const EM = 'formatting_formatting-em_em';
const STRIKE = 'formatting_formatting-strikethrough_strikethrough';
const HIGHLIGHT = 'formatting_formatting-highlight_highlight';
const CODE = 'formatting_formatting-code_inline-code';
const EM_STRONG = 'formatting_formatting-em_formatting-strong_em_strong';

/**
 * Builds tokens from a line of text. Each marker string is found left to
 * right and gets the given node name.
 */
function tokens(text: string, markers: [string, string][], offset = 0): Token[] {
	const out: Token[] = [];
	let at = 0;
	for (const [mark, name] of markers) {
		const i = text.indexOf(mark, at);
		assert.ok(i >= 0, `marker ${mark} not found after ${at}`);
		out.push({ from: offset + i, to: offset + i + mark.length, name });
		at = i + mark.length;
	}
	return out;
}

const prev = (p: number) => p - 1;
const next = (p: number) => p + 1;

test('markerKinds reads inline style markers only', () => {
	assert.deepEqual(markerKinds(STRONG), ['strong']);
	assert.deepEqual(markerKinds(EM), ['em']);
	assert.deepEqual(markerKinds(STRIKE), ['strike']);
	assert.deepEqual(markerKinds(HIGHLIGHT), ['highlight']);
	assert.deepEqual(markerKinds(CODE), ['code']);
	assert.deepEqual(markerKinds(EM_STRONG), ['em', 'strong']);
	// Not markers: content, block markers, links, code fences, math.
	assert.deepEqual(markerKinds('strong'), []);
	assert.deepEqual(markerKinds('inline-code'), []);
	assert.deepEqual(markerKinds('formatting_formatting-header_formatting-header-1_header_header-1'), []);
	assert.deepEqual(markerKinds('formatting_formatting-list_formatting-list-ul_list-1'), []);
	assert.deepEqual(markerKinds('formatting_formatting-quote_formatting-quote-1_quote_quote-1'), []);
	assert.deepEqual(markerKinds('formatting-link_link'), []);
	assert.deepEqual(markerKinds('formatting_formatting-code-block_hmd-codeblock'), []);
	assert.deepEqual(markerKinds('formatting_formatting-math_math'), []);
});

test('hides both markers of each closed inline style', () => {
	const cases: [string, string, string][] = [
		['a **b** c', '**', STRONG],
		['a *b* c', '*', EM],
		['a ~~b~~ c', '~~', STRIKE],
		['a ==b== c', '==', HIGHLIGHT],
		['a `b` c', '`', CODE],
	];
	for (const [text, mark, name] of cases) {
		const line = tokens(text, [[mark, name], [mark, name]]);
		const { hidden, pairs } = computeHidden([line]);
		assert.deepEqual(hidden, line.map(({ from, to }) => ({ from, to })), text);
		assert.equal(pairs.length, 1, text);
	}
});

test('keeps an unclosed marker visible', () => {
	const line = tokens('a **b', [['**', STRONG]]);
	assert.deepEqual(computeHidden([line]).hidden, []);
});

test('pairs per line, so markers do not pair across lines', () => {
	const l1 = tokens('a **b', [['**', STRONG]]);
	const l2 = tokens('c** d', [['**', STRONG]], 6);
	assert.deepEqual(computeHidden([l1, l2]).hidden, []);
});

test('three markers in a line: the first two pair, the third stays visible', () => {
	const line = tokens('**a** **b', [['**', STRONG], ['**', STRONG], ['**', STRONG]]);
	assert.deepEqual(computeHidden([line]).hidden, [
		{ from: 0, to: 2 },
		{ from: 3, to: 5 },
	]);
});

test('different styles pair independently', () => {
	const line = tokens('**a** ==b', [['**', STRONG], ['**', STRONG], ['==', HIGHLIGHT]]);
	assert.deepEqual(computeHidden([line]).hidden, [
		{ from: 0, to: 2 },
		{ from: 3, to: 5 },
	]);
});

test('nested styles as separate tokens merge into one hidden range per side', () => {
	// ***x*** tokenized as ** + * ... * + **
	const line = tokens('***x***', [
		['**', STRONG],
		['*', EM],
		['*', EM],
		['**', STRONG],
	]);
	const { hidden, pairs } = computeHidden([line]);
	assert.deepEqual(hidden, [
		{ from: 0, to: 3 },
		{ from: 4, to: 7 },
	]);
	assert.equal(pairs.length, 2);
});

test('one token that carries two styles is hidden when both close', () => {
	const line = tokens('***x***', [['***', EM_STRONG], ['***', EM_STRONG]]);
	assert.deepEqual(computeHidden([line]).hidden, [
		{ from: 0, to: 3 },
		{ from: 4, to: 7 },
	]);
});

test('mixed close order: ***a** b*', () => {
	const line = tokens('***a** b*', [['***', EM_STRONG], ['**', STRONG], ['*', EM]]);
	assert.deepEqual(computeHidden([line]).hidden, [
		{ from: 0, to: 3 },
		{ from: 4, to: 6 },
		{ from: 8, to: 9 },
	]);
});

test('a two-style token stays visible if only one style closes', () => {
	const line = tokens('***a** b', [['***', EM_STRONG], ['**', STRONG]]);
	assert.deepEqual(computeHidden([line]).hidden, [{ from: 4, to: 6 }]);
});

test('ignores empty tokens', () => {
	const line: Token[] = [
		{ from: 0, to: 0, name: STRONG },
		{ from: 0, to: 2, name: STRONG },
		{ from: 3, to: 5, name: STRONG },
	];
	assert.deepEqual(computeHidden([line]).hidden, [
		{ from: 0, to: 2 },
		{ from: 3, to: 5 },
	]);
});

test('mergeRanges joins touching and overlapping ranges', () => {
	assert.deepEqual(
		mergeRanges([
			{ from: 5, to: 6 },
			{ from: 0, to: 2 },
			{ from: 2, to: 3 },
			{ from: 5, to: 8 },
		]),
		[
			{ from: 0, to: 3 },
			{ from: 5, to: 8 },
		],
	);
});

// "a **bold** c": open ** = 2..4, "bold" = 4..8, close ** = 8..10
const BOLD = computeHidden([tokens('a **bold** c', [['**', STRONG], ['**', STRONG]])]);

test('typing at the end of a styled span stays inside it', () => {
	// Cursor before the closing marker: already inside.
	assert.equal(insertPosition(8, BOLD.hidden), 8);
	// Cursor after the closing marker looks the same on screen: move inside.
	assert.equal(insertPosition(10, BOLD.hidden), 8);
});

test('typing at the start of a styled span goes outside it', () => {
	// Cursor after the opening marker: move before it.
	assert.equal(insertPosition(4, BOLD.hidden), 2);
	// Cursor before the opening marker: already outside.
	assert.equal(insertPosition(2, BOLD.hidden), 2);
});

test('typing away from markers is unchanged', () => {
	assert.equal(insertPosition(6, BOLD.hidden), 6);
	assert.equal(insertPosition(0, BOLD.hidden), 0);
	assert.equal(insertPosition(4, []), 4);
});

test('nested markers: end goes to the innermost span, start goes fully outside', () => {
	const line = tokens('***x***', [['**', STRONG], ['*', EM], ['*', EM], ['**', STRONG]]);
	const { hidden } = computeHidden([line]);
	assert.equal(insertPosition(7, hidden), 4);
	assert.equal(insertPosition(3, hidden), 0);
});

test('Backspace after a hidden marker deletes the letter before it, not the marker', () => {
	// After the closing marker: delete "d".
	assert.deepEqual(backspaceRange(10, BOLD.hidden, BOLD.pairs, prev), { from: 7, to: 8 });
	// After the opening marker: delete the space before it.
	assert.deepEqual(backspaceRange(4, BOLD.hidden, BOLD.pairs, prev), { from: 1, to: 2 });
});

test('Backspace with no hidden marker before the cursor is left to the editor', () => {
	assert.equal(backspaceRange(6, BOLD.hidden, BOLD.pairs, prev), null);
	assert.equal(backspaceRange(8, BOLD.hidden, BOLD.pairs, prev), null);
	assert.equal(backspaceRange(0, BOLD.hidden, BOLD.pairs, prev), null);
});

test('Backspace after a marker at the start of the document does nothing', () => {
	const { hidden, pairs } = computeHidden([tokens('**b**', [['**', STRONG], ['**', STRONG]])]);
	assert.deepEqual(backspaceRange(2, hidden, pairs, prev), { from: 0, to: 0 });
});

test('deleting the last letter of a span removes its markers too', () => {
	// "a **b** c": open 2..4, "b" 4..5, close 5..7
	const { hidden, pairs } = computeHidden([tokens('a **b** c', [['**', STRONG], ['**', STRONG]])]);
	assert.deepEqual(backspaceRange(5, hidden, pairs, prev), { from: 2, to: 7 });
	assert.deepEqual(backspaceRange(7, hidden, pairs, prev), { from: 2, to: 7 });
	assert.deepEqual(deleteForwardRange(4, hidden, pairs, 9, next), { from: 2, to: 7 });
	assert.deepEqual(deleteForwardRange(2, hidden, pairs, 9, next), { from: 2, to: 7 });
});

test('deleting the last letter of nested spans removes all their markers', () => {
	const line = tokens('***x***', [['**', STRONG], ['*', EM], ['*', EM], ['**', STRONG]]);
	const { hidden, pairs } = computeHidden([line]);
	assert.deepEqual(backspaceRange(7, hidden, pairs, prev), { from: 0, to: 7 });
});

test('nested spans that close in a different order are also removed together', () => {
	// ** * x ** * : strong 0..2 / 4..6, em 2..3 / 6..7
	const line = tokens('***x***', [['**', STRONG], ['*', EM], ['**', STRONG], ['*', EM]]);
	const { hidden, pairs } = computeHidden([line]);
	assert.deepEqual(backspaceRange(4, hidden, pairs, prev), { from: 0, to: 7 });
});

test('emptying a span keeps the markers of the span before it', () => {
	// "**a***b*": strong 0..2 / 3..5, em 5..6 / 7..8
	const line = tokens('**a***b*', [['**', STRONG], ['**', STRONG], ['*', EM], ['*', EM]]);
	const { hidden, pairs } = computeHidden([line]);
	assert.deepEqual(backspaceRange(7, hidden, pairs, prev), { from: 5, to: 8 });
});

test('Delete before a hidden marker deletes the letter after it, not the marker', () => {
	// Before the closing marker: delete the space after it.
	assert.deepEqual(deleteForwardRange(8, BOLD.hidden, BOLD.pairs, 12, next), { from: 10, to: 11 });
	// Before the opening marker: delete "b".
	assert.deepEqual(deleteForwardRange(2, BOLD.hidden, BOLD.pairs, 12, next), { from: 4, to: 5 });
	// No marker after the cursor.
	assert.equal(deleteForwardRange(6, BOLD.hidden, BOLD.pairs, 12, next), null);
});

test('arrow keys skip the duplicate stop at a hidden marker', () => {
	// "a **bold** c": 2..4 and 8..10 are hidden.
	assert.equal(skipHiddenEdge(2, BOLD.hidden, true), 4);
	assert.equal(skipHiddenEdge(3, BOLD.hidden, true), 4);
	assert.equal(skipHiddenEdge(8, BOLD.hidden, true), 10);
	assert.equal(skipHiddenEdge(10, BOLD.hidden, false), 8);
	assert.equal(skipHiddenEdge(3, BOLD.hidden, false), 2);
	assert.equal(skipHiddenEdge(4, BOLD.hidden, false), 2);
	// No marker in the way.
	assert.equal(skipHiddenEdge(6, BOLD.hidden, true), 6);
	assert.equal(skipHiddenEdge(4, BOLD.hidden, true), 4);
	assert.equal(skipHiddenEdge(2, BOLD.hidden, false), 2);
});

test('Delete before a marker at the end of the document does nothing', () => {
	const { hidden, pairs } = computeHidden([tokens('**b**', [['**', STRONG], ['**', STRONG]])]);
	assert.deepEqual(deleteForwardRange(3, hidden, pairs, 5, next), { from: 5, to: 5 });
});
