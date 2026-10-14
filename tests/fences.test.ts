import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	type LineInfo,
	fenceBackspace,
	fenceDelete,
	fenceTypingPos,
	hasOpenFence,
	languageOf,
	onFenceLine,
	parseFences,
	planFenceCreate,
	planLanguage,
	skipFence,
} from '../src/fences.ts';

function lines(doc: string): LineInfo[] {
	const out: LineInfo[] = [];
	let from = 0;
	for (const text of doc.split('\n')) {
		out.push({ from, text });
		from += text.length + 1;
	}
	return out;
}

const slice = (doc: string) => (a: number, b: number) => doc.slice(a, b);

// "a\n```js\ncode\n```\nb"
//  0 2      8    13   17
const DOC = 'a\n```js\ncode\n```\nb';
const [BLOCK] = parseFences(lines(DOC));

test('finds a closed code block with its language', () => {
	assert.deepEqual(BLOCK, {
		open: { from: 2, to: 7 },
		close: { from: 13, to: 16 },
		lang: { from: 5, to: 7 },
		content: { from: 8, to: 12 },
	});
	assert.equal(languageOf(BLOCK!, slice(DOC)), 'js');
});

test('tildes work the same, and the closing fence may be longer', () => {
	const doc = '~~~python\nx = 1\n~~~~';
	const [b] = parseFences(lines(doc));
	assert.ok(b);
	assert.equal(languageOf(b, slice(doc)), 'python');
});

test('a closing fence must use the same character and be at least as long', () => {
	assert.deepEqual(parseFences(lines('```\nx\n~~~')), []);
	assert.deepEqual(parseFences(lines('````\nx\n```')), []);
	assert.equal(parseFences(lines('````\nx\n```\ny\n````')).length, 1);
});

test('an unclosed block is not returned, so its fences stay visible', () => {
	assert.deepEqual(parseFences(lines('```js\ncode')), []);
});

test('a block with no code line stays visible', () => {
	assert.deepEqual(parseFences(lines('```\n```')), []);
});

test('an empty code line counts as content', () => {
	const [b] = parseFences(lines('```\n\n```'));
	assert.deepEqual(b?.content, { from: 4, to: 4 });
});

test('several blocks, and ``` inside a ~~~ block is just code', () => {
	const doc = '```\na\n```\n~~~\n```\n~~~';
	const blocks = parseFences(lines(doc));
	assert.equal(blocks.length, 2);
	assert.equal(doc.slice(blocks[1]!.content.from, blocks[1]!.content.to), '```');
});

test('fences indented by 4 spaces or inside quotes are not fences', () => {
	assert.deepEqual(parseFences(lines('    ```\n    x\n    ```')), []);
	assert.deepEqual(parseFences(lines('> ```\n> x\n> ```')), []);
});

test('hasOpenFence tells when the lines end inside a block', () => {
	assert.equal(hasOpenFence(lines('```js\ncode')), true);
	assert.equal(hasOpenFence(lines('```js\ncode\n```')), false);
	assert.equal(hasOpenFence(lines('plain')), false);
});

test('text typed on a hidden fence line goes into the code', () => {
	assert.equal(fenceTypingPos(2, [BLOCK!]), 8);
	assert.equal(fenceTypingPos(7, [BLOCK!]), 8);
	assert.equal(fenceTypingPos(13, [BLOCK!]), 12);
	assert.equal(fenceTypingPos(16, [BLOCK!]), 12);
	assert.equal(fenceTypingPos(10, [BLOCK!]), 10);
	assert.equal(onFenceLine(5, [BLOCK!]), true);
	assert.equal(onFenceLine(10, [BLOCK!]), false);
});

test('arrow keys pass over hidden fence lines', () => {
	// Right from the end of "a" lands on the opening fence: go to the code.
	assert.equal(skipFence(2, [BLOCK!], true, DOC.length), 8);
	// Left from the code start lands on the fence end: go to the end of "a".
	assert.equal(skipFence(7, [BLOCK!], false, DOC.length), 1);
	// Right from the code end lands on the closing fence: go to "b".
	assert.equal(skipFence(13, [BLOCK!], true, DOC.length), 17);
	// Left from "b" lands on the closing fence end: go to the code end.
	assert.equal(skipFence(16, [BLOCK!], false, DOC.length), 12);
	// Inside the code: unchanged.
	assert.equal(skipFence(10, [BLOCK!], true, DOC.length), 10);
});

test('Backspace in an empty block removes the whole block', () => {
	const doc = 'a\n```\n\n```\nb';
	const [b] = parseFences(lines(doc));
	assert.deepEqual(fenceBackspace(6, [b!]), { from: 2, to: 10, cursor: 2 });
});

test('Backspace at the start of the code or the line after does nothing', () => {
	assert.deepEqual(fenceBackspace(8, [BLOCK!]), { from: 8, to: 8, cursor: 8 });
	assert.deepEqual(fenceBackspace(17, [BLOCK!]), { from: 17, to: 17, cursor: 17 });
	assert.equal(fenceBackspace(10, [BLOCK!]), null);
});

test('Delete at the end of the code or the line before does nothing', () => {
	assert.equal(fenceDelete(12, [BLOCK!]), true);
	assert.equal(fenceDelete(1, [BLOCK!]), true);
	assert.equal(fenceDelete(10, [BLOCK!]), false);
});

test('typing the third backtick on an empty line makes a block', () => {
	assert.deepEqual(planFenceCreate({ from: 4, text: '``' }, 2, '`'), {
		from: 4,
		to: 6,
		insert: '```\n\n```',
		cursor: 8,
	});
	assert.deepEqual(planFenceCreate({ from: 0, text: '~~' }, 2, '~')?.insert, '~~~\n\n~~~');
	assert.deepEqual(planFenceCreate({ from: 0, text: '  ``' }, 4, '`'), {
		from: 0,
		to: 4,
		insert: '  ```\n  \n  ```',
		cursor: 8,
	});
});

test('no block from other text, or when a fence above is still open', () => {
	assert.equal(planFenceCreate({ from: 0, text: 'a``' }, 3, '`'), null);
	assert.equal(planFenceCreate({ from: 0, text: '`' }, 1, '`'), null);
	assert.equal(planFenceCreate({ from: 0, text: '```' }, 3, '`'), null);
	assert.equal(planFenceCreate({ from: 0, text: '``' }, 2, 'x'), null);
	// Closing a block written by hand: the ``` closes it instead.
	assert.equal(planFenceCreate({ from: 11, text: '``' }, 2, '`', lines('```js\ncode')), null);
});

test('changing the language rewrites the info string', () => {
	assert.deepEqual(planLanguage(BLOCK!, ' python '), { from: 5, to: 7, insert: 'python', cursor: 11 });
	assert.deepEqual(planLanguage(BLOCK!, ''), { from: 5, to: 7, insert: '', cursor: 5 });
	assert.equal(planLanguage(BLOCK!, 'c sharp').insert, 'c-sharp');
});
