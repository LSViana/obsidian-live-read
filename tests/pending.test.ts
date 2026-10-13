import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Kind, type Token, computeHidden } from '../src/hidden-ranges.ts';
import { planPendingInput, togglePending } from '../src/pending.ts';

const STRONG = 'formatting_formatting-strong_strong';
const EM = 'formatting_formatting-em_em';
const CODE = 'formatting_formatting-code_inline-code';

function tokens(text: string, markers: [string, string][]): Token[] {
	const out: Token[] = [];
	let at = 0;
	for (const [mark, name] of markers) {
		const i = text.indexOf(mark, at);
		assert.ok(i >= 0, `marker ${mark} not found after ${at}`);
		out.push({ from: i, to: i + mark.length, name });
		at = i + mark.length;
	}
	return out;
}

/** Applies the planned edit to `doc` and returns the new text and cursor. */
function typeWith(doc: string, markers: [string, string][], pos: number, pending: Kind[], text = 'x') {
	const { pairs, hidden } = computeHidden([tokens(doc, markers)]);
	const edit = planPendingInput({
		pos,
		text,
		pending,
		pairs,
		hidden,
		slice: (a, b) => doc.slice(a, b),
	});
	return { doc: doc.slice(0, edit.from) + edit.insert + doc.slice(edit.from), cursor: edit.cursor };
}

const BOLD: [string, string][] = [
	['**', STRONG],
	['**', STRONG],
];

test('togglePending adds a style, and pressing it again cancels it', () => {
	assert.deepEqual(togglePending([], 'strong'), ['strong']);
	assert.deepEqual(togglePending(['strong'], 'strong'), []);
	assert.deepEqual(togglePending(['strong'], 'em'), ['strong', 'em']);
	assert.deepEqual(togglePending(['strong', 'em'], 'strong'), ['em']);
});

test('outside any span: typed text starts a new span, cursor stays inside it', () => {
	assert.deepEqual(typeWith('a  b', [], 2, ['strong']), { doc: 'a **x** b', cursor: 5 });
	assert.deepEqual(typeWith('a  b', [], 2, ['em']), { doc: 'a *x* b', cursor: 4 });
	assert.deepEqual(typeWith('a  b', [], 2, ['strike']), { doc: 'a ~~x~~ b', cursor: 5 });
	assert.deepEqual(typeWith('a  b', [], 2, ['highlight']), { doc: 'a ==x== b', cursor: 5 });
	assert.deepEqual(typeWith('a  b', [], 2, ['code']), { doc: 'a `x` b', cursor: 4 });
});

test('two styles at once nest in press order', () => {
	assert.deepEqual(typeWith('', [], 0, ['strong', 'em']), { doc: '***x***', cursor: 4 });
	assert.deepEqual(typeWith('', [], 0, ['em', 'strong']), { doc: '***x***', cursor: 4 });
});

test('at the end of a bold span: the text goes after it, plain', () => {
	// "a **bold** c": the cursor after "bold" can be at 8 or 10.
	assert.deepEqual(typeWith('a **bold** c', BOLD, 8, ['strong']), { doc: 'a **bold**x c', cursor: 11 });
	assert.deepEqual(typeWith('a **bold** c', BOLD, 10, ['strong']), { doc: 'a **bold**x c', cursor: 11 });
});

test('in the middle of a bold span: the span is split around the text', () => {
	assert.deepEqual(typeWith('a **bold** c', BOLD, 6, ['strong']), {
		doc: 'a **bo**x**ld** c',
		cursor: 9,
	});
});

test('a split copies the span marker, so __bold__ stays __', () => {
	const r = typeWith('a __bold__ c', [['__', STRONG], ['__', STRONG]], 6, ['strong']);
	assert.equal(r.doc, 'a __bo__x__ld__ c');
});

test('right before a bold span: turning bold on joins that span', () => {
	assert.deepEqual(typeWith('a **bold** c', BOLD, 2, ['strong']), { doc: 'a **xbold** c', cursor: 5 });
	// The cursor right after the opening marker looks the same on screen.
	assert.deepEqual(typeWith('a **bold** c', BOLD, 4, ['strong']), { doc: 'a **xbold** c', cursor: 5 });
});

test('turning italic on inside bold nests a new italic span', () => {
	assert.deepEqual(typeWith('a **bold** c', BOLD, 6, ['em']), { doc: 'a **bo*x*ld** c', cursor: 8 });
});

test('leaving bold and starting italic at the end of a span', () => {
	assert.deepEqual(typeWith('a **bold** c', BOLD, 8, ['strong', 'em']), {
		doc: 'a **bold***x* c',
		cursor: 12,
	});
});

test('leaving nested bold italic at its end, in either press order', () => {
	const nested: [string, string][] = [
		['**', STRONG],
		['*', EM],
		['*', EM],
		['**', STRONG],
	];
	for (const pending of [['strong', 'em'], ['em', 'strong']] as Kind[][]) {
		assert.deepEqual(typeWith('***y*** z', nested, 7, pending), { doc: '***y***x z', cursor: 8 }, pending.join());
	}
});

test('inside inline code, the code toggle splits the code span', () => {
	const r = typeWith('`ab`', [['`', CODE], ['`', CODE]], 2, ['code']);
	assert.equal(r.doc, '`a`x`b`');
});

test('typed text with several characters is kept whole', () => {
	assert.deepEqual(typeWith('', [], 0, ['strong'], 'hey'), { doc: '**hey**', cursor: 5 });
});
