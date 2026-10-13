// Runs the Live Read editor extension in a real CodeMirror editor (inside a
// fake browser page). A small stream parser stands in for Obsidian's markdown
// parser and produces the same node names, like
// "formatting_formatting-strong_strong".
import './setup-dom';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamLanguage } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { liveReadExtension, toggleStyleAtCursor } from '../../src/extension';
import { editorLivePreviewField, setLivePreview } from './obsidian-mock';

interface Styles {
	strong: boolean;
	em: boolean;
	strike: boolean;
	highlight: boolean;
	code: boolean;
}

const fresh = (): Styles => ({ strong: false, em: false, strike: false, highlight: false, code: false });

function styleNames(s: Styles): string[] {
	const out: string[] = [];
	if (s.strong) out.push('strong');
	if (s.em) out.push('em');
	if (s.strike) out.push('strikethrough');
	if (s.highlight) out.push('highlight');
	return out;
}

const markdownLike = StreamLanguage.define<Styles>({
	name: 'markdown-like',
	// Upstream CodeMirror drops tokens it cannot map to a highlight tag.
	// Obsidian's parser keeps them, so map every class to some tag.
	tokenTable: Object.fromEntries(
		[
			'formatting',
			'formatting-strong',
			'formatting-em',
			'formatting-strikethrough',
			'formatting-highlight',
			'formatting-code',
			'strong',
			'em',
			'strikethrough',
			'highlight',
			'inline-code',
		].map((name) => [name, tags.content]),
	),
	startState: fresh,
	copyState: (s) => ({ ...s }),
	token(stream, s) {
		if (stream.sol()) Object.assign(s, fresh());
		if (s.code) {
			if (stream.eat('`')) {
				s.code = false;
				return 'formatting formatting-code inline-code';
			}
			stream.eatWhile((c) => c !== '`');
			return 'inline-code';
		}
		if (stream.eat('`')) {
			s.code = true;
			return 'formatting formatting-code inline-code';
		}
		const markers: [string, keyof Styles, string][] = [
			['**', 'strong', 'formatting-strong'],
			['~~', 'strike', 'formatting-strikethrough'],
			['==', 'highlight', 'formatting-highlight'],
			['*', 'em', 'formatting-em'],
		];
		for (const [mark, key, cls] of markers) {
			if (stream.match(mark)) {
				const before = styleNames(s);
				s[key] = !s[key];
				const span = s[key] ? styleNames(s) : before;
				return ['formatting', cls, ...span].join(' ');
			}
		}
		stream.next();
		stream.eatWhile((c) => !'*~=`'.includes(c));
		return styleNames(s).join(' ') || null;
	},
});

function makeView(doc: string, cursor = 0, liveRead = true): EditorView {
	return new EditorView({
		state: EditorState.create({
			doc,
			selection: EditorSelection.cursor(cursor),
			extensions: [
				markdownLike,
				editorLivePreviewField,
				liveRead ? liveReadExtension() : [],
				keymap.of(defaultKeymap),
			],
		}),
		parent: document.body,
	});
}

function hiddenRanges(view: EditorView): [number, number][] {
	const out: [number, number][] = [];
	for (const source of view.state.facet(EditorView.atomicRanges)) {
		source(view).between(0, view.state.doc.length, (from, to) => {
			out.push([from, to]);
		});
	}
	return out;
}

function shownText(view: EditorView): string {
	return view.contentDOM.textContent ?? '';
}

function press(view: EditorView, key: string): boolean {
	const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
	return runScopeHandlers(view, event, 'editor');
}

/** Types text the way the browser would: input handlers first, then a plain insert. */
function type(view: EditorView, text: string) {
	const { from, to } = view.state.selection.main;
	const insert = () => view.state.update({ changes: { from, to, insert: text } });
	for (const handler of view.state.facet(EditorView.inputHandler)) {
		if (handler(view, from, to, text, insert)) return;
	}
	view.dispatch({
		changes: { from, to, insert: text },
		selection: { anchor: from + text.length },
	});
}

const cursor = (view: EditorView) => view.state.selection.main.head;

test('hides closed inline markers in Live Preview', () => {
	const view = makeView('a **bold** c');
	assert.deepEqual(hiddenRanges(view), [
		[2, 4],
		[8, 10],
	]);
	assert.equal(shownText(view), 'a bold c');
	view.destroy();
});

test('hides all five inline styles', () => {
	const view = makeView('**b** *i* ~~s~~ ==h== `c`');
	assert.equal(shownText(view), 'b i s h c');
	view.destroy();
});

test('keeps an unclosed marker visible', () => {
	const view = makeView('a **bold');
	assert.deepEqual(hiddenRanges(view), []);
	assert.equal(shownText(view), 'a **bold');
	view.destroy();
});

test('does nothing outside Live Preview, and comes back with it', () => {
	const view = makeView('a **bold** c');
	view.dispatch({ effects: setLivePreview.of(false) });
	assert.deepEqual(hiddenRanges(view), []);
	assert.equal(shownText(view), 'a **bold** c');
	view.dispatch({ effects: setLivePreview.of(true) });
	assert.equal(shownText(view), 'a bold c');
	view.destroy();
});

test('typing at the end of a bold span stays bold', () => {
	const view = makeView('a **bold** c', 10);
	type(view, 'X');
	assert.equal(view.state.doc.toString(), 'a **boldX** c');
	assert.equal(cursor(view), 9);
	type(view, 'Y');
	assert.equal(view.state.doc.toString(), 'a **boldXY** c');
	assert.deepEqual(hiddenRanges(view), [
		[2, 4],
		[10, 12],
	]);
	view.destroy();
});

test('typing at the start of a bold span goes outside it', () => {
	const view = makeView('a **bold** c', 4);
	type(view, 'X');
	assert.equal(view.state.doc.toString(), 'a X**bold** c');
	assert.equal(cursor(view), 3);
	view.destroy();
});

test('ArrowRight moves one visible letter per press', () => {
	const view = makeView('a **bold** c', 0);
	const stops: number[] = [];
	for (let i = 0; i < 8; i++) {
		press(view, 'ArrowRight');
		stops.push(cursor(view));
	}
	// Visible text "a bold c" has 8 letters, so 8 presses reach the end.
	assert.deepEqual(stops, [1, 4, 5, 6, 7, 10, 11, 12]);
	view.destroy();
});

test('ArrowLeft moves one visible letter per press', () => {
	const view = makeView('a **bold** c', 12);
	const stops: number[] = [];
	for (let i = 0; i < 8; i++) {
		press(view, 'ArrowLeft');
		stops.push(cursor(view));
	}
	assert.deepEqual(stops, [11, 8, 7, 6, 5, 2, 1, 0]);
	view.destroy();
});

test('Backspace right after a hidden marker deletes a letter, keeps the bold', () => {
	const view = makeView('a **bold** c', 10);
	assert.equal(press(view, 'Backspace'), true);
	assert.equal(view.state.doc.toString(), 'a **bol** c');
	assert.equal(cursor(view), 7);
	view.destroy();
});

test('Backspace on the last letter removes the empty span', () => {
	const view = makeView('a **b** c', 7);
	press(view, 'Backspace');
	assert.equal(view.state.doc.toString(), 'a  c');
	assert.equal(cursor(view), 2);
	view.destroy();
});

test('Delete right before a hidden marker deletes a letter, keeps the bold', () => {
	const view = makeView('a **bold** c', 2);
	press(view, 'Delete');
	assert.equal(view.state.doc.toString(), 'a **old** c');
	view.destroy();
});

test('Backspace away from markers works as usual', () => {
	const view = makeView('a **bold** c', 6);
	press(view, 'Backspace');
	assert.equal(view.state.doc.toString(), 'a **bld** c');
	view.destroy();
});

test('nested bold italic: hidden, typing at the end stays inside, last letter cleans up', () => {
	const view = makeView('a ***x*** b', 9);
	assert.equal(shownText(view), 'a x b');
	type(view, 'y');
	assert.equal(view.state.doc.toString(), 'a ***xy*** b');
	press(view, 'Backspace');
	press(view, 'Backspace');
	assert.equal(view.state.doc.toString(), 'a  b');
	view.destroy();
});

test('typing at the end of italic, highlight and code stays inside', () => {
	for (const [doc, pos, out] of [
		['*i*', 3, '*iX*'],
		['==h==', 5, '==hX=='],
		['`c`', 3, '`cX`'],
		['~~s~~', 5, '~~sX~~'],
	] as const) {
		const view = makeView(doc, pos);
		type(view, 'X');
		assert.equal(view.state.doc.toString(), out, doc);
		view.destroy();
	}
});

test('multi-line documents: each line is handled on its own', () => {
	const view = makeView('**a**\nplain **b\n==c==');
	assert.equal(shownText(view), 'aplain **bc');
	view.destroy();
});

// Style toggles (Ctrl+B and friends), Notion style.

const doc = (view: EditorView) => view.state.doc.toString();

test('Ctrl+B with no selection writes nothing until a letter is typed', () => {
	const view = makeView('a  b', 2);
	assert.equal(toggleStyleAtCursor(view, 'strong'), true);
	assert.equal(doc(view), 'a  b');
	type(view, 'h');
	type(view, 'i');
	assert.equal(doc(view), 'a **hi** b');
	assert.equal(shownText(view), 'a hi b');
	view.destroy();
});

test('pressing Ctrl+B again turns bold off for the next letters', () => {
	const view = makeView('', 0);
	toggleStyleAtCursor(view, 'strong');
	type(view, 'a');
	toggleStyleAtCursor(view, 'strong');
	type(view, 'b');
	type(view, 'c');
	assert.equal(doc(view), '**a**bc');
	view.destroy();
});

test('pressing Ctrl+B twice before typing cancels it', () => {
	const view = makeView('', 0);
	toggleStyleAtCursor(view, 'strong');
	toggleStyleAtCursor(view, 'strong');
	type(view, 'a');
	assert.equal(doc(view), 'a');
	view.destroy();
});

test('moving the cursor without typing cancels the pending style', () => {
	const view = makeView('ab', 2);
	toggleStyleAtCursor(view, 'strong');
	view.dispatch({ selection: { anchor: 1 } });
	type(view, 'x');
	assert.equal(doc(view), 'axb');
	view.destroy();
});

test('Ctrl+B inside a bold word closes it there, so the next letters are plain', () => {
	const middle = makeView('a **bold** c', 6);
	toggleStyleAtCursor(middle, 'strong');
	type(middle, 'x');
	assert.equal(doc(middle), 'a **bo**x**ld** c');
	assert.equal(shownText(middle), 'a boxld c');
	middle.destroy();

	const end = makeView('a **bold** c', 10);
	toggleStyleAtCursor(end, 'strong');
	type(end, 'x');
	type(end, 'y');
	assert.equal(doc(end), 'a **bold**xy c');
	end.destroy();
});

test('every style toggle works the same way', () => {
	for (const [kind, out] of [
		['em', '*x*'],
		['strike', '~~x~~'],
		['highlight', '==x=='],
		['code', '`x`'],
	] as const) {
		const view = makeView('', 0);
		toggleStyleAtCursor(view, kind);
		type(view, 'x');
		assert.equal(doc(view), out, kind);
		assert.equal(shownText(view), 'x', kind);
		view.destroy();
	}
});

test('bold and italic together', () => {
	const view = makeView('', 0);
	toggleStyleAtCursor(view, 'strong');
	toggleStyleAtCursor(view, 'em');
	type(view, 'x');
	type(view, 'y');
	assert.equal(doc(view), '***xy***');
	assert.equal(shownText(view), 'xy');
	view.destroy();
});

test('with a selection, Obsidian handles it (wrap or unwrap)', () => {
	const view = makeView('abc', 0);
	view.dispatch({ selection: { anchor: 0, head: 2 } });
	assert.equal(toggleStyleAtCursor(view, 'strong'), false);
	view.destroy();
});

test('outside Live Preview, or with Live Read off, Obsidian handles it', () => {
	const source = makeView('abc', 1);
	source.dispatch({ effects: setLivePreview.of(false) });
	assert.equal(toggleStyleAtCursor(source, 'strong'), false);
	source.destroy();

	const off = makeView('abc', 1, false);
	assert.equal(toggleStyleAtCursor(off, 'strong'), false);
	off.destroy();
});
