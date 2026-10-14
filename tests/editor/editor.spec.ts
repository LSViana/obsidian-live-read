// Runs the Live Read editor extension in a real CodeMirror editor (inside a
// fake browser page). A small stream parser stands in for Obsidian's markdown
// parser and produces the same node names, like
// "formatting_formatting-strong_strong".
import './setup-dom';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HighlightStyle, StreamLanguage, type StringStream, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import {
	type LiveReadOptions,
	applyLinkEdit,
	linkContext,
	liveReadExtension,
	toggleStyleAtCursor,
} from '../../src/extension';
import { editorLivePreviewField, setLivePreview } from './obsidian-mock';

interface Styles {
	strong: boolean;
	em: boolean;
	strike: boolean;
	highlight: boolean;
	code: boolean;
	/** Where we are inside a link, like Obsidian's parser tracks it. */
	link: 'none' | 'mdText' | 'mdAfter' | 'mdUrl' | 'wiki';
	image: boolean;
	embed: boolean;
	wikiAlias: boolean;
	inAlias: boolean;
	/** Still at the start of the line, where block markers can be. */
	lead: boolean;
	afterList: boolean;
	quotes: number;
	/** Inside a fenced code block: its fence character, kept across lines. */
	fence: string | null;
}

const fresh = (): Styles => ({
	strong: false,
	em: false,
	strike: false,
	highlight: false,
	code: false,
	link: 'none',
	image: false,
	embed: false,
	wikiAlias: false,
	inAlias: false,
	lead: true,
	afterList: false,
	quotes: 0,
	fence: null,
});

function styleNames(s: Styles): string[] {
	const out: string[] = [];
	if (s.strong) out.push('strong');
	if (s.em) out.push('em');
	if (s.strike) out.push('strikethrough');
	if (s.highlight) out.push('highlight');
	return out;
}

const join = (...parts: (string | false)[]) => parts.filter(Boolean).join(' ');

/** Link tokens with the same classes Obsidian 1.14 uses. */
function linkToken(stream: StringStream, s: Styles): string | null | undefined {
	const img = s.image && 'image';
	if (s.link === 'wiki') {
		if (stream.match(']]')) {
			s.link = 'none';
			s.embed = s.wikiAlias = s.inAlias = false;
			return 'formatting-link formatting-link-end';
		}
		if (stream.eat('|')) {
			s.inAlias = true;
			return 'hmd-internal-link link-alias-pipe';
		}
		if (!stream.eatWhile((c) => c !== '|' && c !== ']')) stream.next();
		return join(
			'hmd-internal-link',
			s.inAlias ? 'link-alias' : s.wikiAlias && 'link-has-alias',
			s.embed && 'hmd-embed',
		);
	}
	if (s.link === 'mdUrl') {
		if (stream.eat(')')) {
			s.link = 'none';
			s.image = false;
			return join('formatting formatting-link-string string url', img);
		}
		stream.eatWhile((c) => c !== ')');
		return join('string url', img);
	}
	if (s.link === 'mdAfter') {
		if (stream.eat('(')) {
			s.link = 'mdUrl';
			return join('formatting formatting-link-string string url', img);
		}
		s.link = 'none';
		s.image = false;
		return undefined;
	}
	if (s.link === 'mdText') {
		if (stream.eat(']')) {
			s.link = 'mdAfter';
			return join('formatting formatting-link link', ...styleNames(s), img);
		}
		return undefined;
	}
	const rest = stream.string.slice(stream.pos);
	const wiki = /^(!?)\[\[([^\]]*)\]\]/.exec(rest);
	if (wiki) {
		stream.pos += wiki[1]!.length + 2;
		s.link = 'wiki';
		s.embed = wiki[1] === '!';
		s.wikiAlias = wiki[2]!.includes('|');
		return join('formatting-link formatting-link-start', s.embed && 'formatting-embed');
	}
	if (rest.startsWith('![')) {
		stream.next();
		s.image = true;
		return 'image image-marker';
	}
	if (stream.eat('[')) {
		s.link = 'mdText';
		return join('formatting formatting-link link', ...styleNames(s), img);
	}
	return undefined;
}

/** Block marker tokens at the line start, with Obsidian's classes. */
function blockToken(stream: StringStream, s: Styles): string | null | undefined {
	if (stream.eatSpace()) return null;
	if (stream.match(/^>[ \t]*/)) {
		const n = ++s.quotes;
		return `formatting formatting-quote formatting-quote-${n} quote quote-${n}`;
	}
	const heading = stream.match(/^(#{1,6})(?=[ \t]|$)[ \t]*/) as RegExpMatchArray | null;
	if (heading) {
		const n = heading[1]!.length;
		s.lead = false;
		return `formatting formatting-header formatting-header-${n} header header-${n}`;
	}
	if (!s.afterList) {
		const list = stream.match(/^([*+-]|\d+[.)])[ \t]+/) as RegExpMatchArray | null;
		if (list) {
			s.afterList = true;
			return `formatting formatting-list formatting-list-${/\d/.test(list[1]!) ? 'ol' : 'ul'} list-1`;
		}
	} else if (stream.match(/^\[[ xX]\](?=\s)/)) {
		s.lead = false;
		return 'formatting formatting-task meta';
	}
	return undefined;
}

const BLOCK_CLASSES = [
	'formatting-quote',
	'formatting-header',
	'formatting-list',
	'formatting-list-ul',
	'formatting-list-ol',
	'formatting-task',
	'quote',
	'header',
	'list-1',
	'meta',
	...[1, 2, 3, 4, 5, 6].flatMap((n) => [
		`formatting-quote-${n}`,
		`quote-${n}`,
		`formatting-header-${n}`,
		`header-${n}`,
	]),
];

const LINK_CLASSES = [
	'formatting-link',
	'formatting-link-start',
	'formatting-link-end',
	'formatting-embed',
	'formatting-link-string',
	'hmd-internal-link',
	'hmd-embed',
	'link-alias',
	'link-alias-pipe',
	'link-has-alias',
	'link',
	'string',
	'url',
	'image',
	'image-marker',
];

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
			...LINK_CLASSES,
			...BLOCK_CLASSES,
			'formatting-code-block',
			'hmd-codeblock',
		].map((name) => [name, tags.content]),
	),
	startState: fresh,
	copyState: (s) => ({ ...s }),
	token(stream, s) {
		if (stream.sol()) {
			const fence = s.fence;
			Object.assign(s, fresh());
			s.fence = fence;
			// Code blocks, with Obsidian's classes: fence lines and code lines.
			const line = stream.string;
			if (s.fence) {
				stream.skipToEnd();
				if (new RegExp(`^ {0,3}${s.fence === '`' ? '`' : '~'}{3,}\\s*$`).test(line)) {
					s.fence = null;
					return 'formatting formatting-code-block hmd-codeblock';
				}
				return 'hmd-codeblock';
			}
			const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
			if (open) {
				s.fence = open[1]![0]!;
				stream.skipToEnd();
				return 'formatting formatting-code-block hmd-codeblock';
			}
		}
		if (s.lead) {
			const block = blockToken(stream, s);
			if (block !== undefined) return block;
			s.lead = false;
		}
		if (s.code) {
			if (stream.eat('`')) {
				s.code = false;
				return 'formatting formatting-code inline-code';
			}
			stream.eatWhile((c) => c !== '`');
			return 'inline-code';
		}
		const link = linkToken(stream, s);
		if (link !== undefined) return link;
		if (stream.eat('`')) {
			s.code = true;
			return 'formatting formatting-code inline-code';
		}
		const markers: [string, 'strong' | 'em' | 'strike' | 'highlight', string][] = [
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
		stream.eatWhile((c) => !'*~=`[]!'.includes(c));
		return join(...styleNames(s), s.link === 'mdText' && 'link', s.link === 'mdText' && s.image && 'image') || null;
	},
});
function makeView(doc: string, cursor = 0, liveRead = true, options: LiveReadOptions = {}): EditorView {
	return new EditorView({
		state: EditorState.create({
			doc,
			selection: EditorSelection.cursor(cursor),
			extensions: [
				markdownLike,
				// Draw tokens in their own elements, as Obsidian does.
				syntaxHighlighting(HighlightStyle.define([{ tag: tags.content, class: 'tok' }])),
				editorLivePreviewField,
				liveRead ? liveReadExtension(options) : [],
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

// Spaces in a styled span (step 4).

test('typing a space at the end of new bold keeps the markers hidden', () => {
	const view = makeView('', 0);
	toggleStyleAtCursor(view, 'strong');
	type(view, 'h');
	type(view, 'i');
	type(view, ' ');
	assert.equal(doc(view), '**hi** ');
	assert.equal(shownText(view), 'hi ');
	type(view, 't');
	assert.equal(doc(view), '**hi t**');
	assert.equal(shownText(view), 'hi t');
	type(view, 'o');
	assert.equal(doc(view), '**hi to**');
	view.destroy();
});

test('several spaces, then a letter, stay in the span', () => {
	const view = makeView('**hi**', 6);
	type(view, ' ');
	type(view, ' ');
	assert.equal(doc(view), '**hi**  ');
	type(view, 'x');
	assert.equal(doc(view), '**hi  x**');
	assert.equal(shownText(view), 'hi  x');
	view.destroy();
});

test('space, then Ctrl+B to turn bold off, then a letter: the letter is plain', () => {
	const view = makeView('', 0);
	toggleStyleAtCursor(view, 'strong');
	type(view, 'h');
	type(view, ' ');
	toggleStyleAtCursor(view, 'strong');
	type(view, 'x');
	assert.equal(doc(view), '**h** x');
	assert.equal(shownText(view), 'h x');
	view.destroy();
});

test('Ctrl+B to turn bold off, then a space, then a letter: plain too', () => {
	const view = makeView('', 0);
	toggleStyleAtCursor(view, 'strong');
	type(view, 'h');
	toggleStyleAtCursor(view, 'strong');
	type(view, ' ');
	type(view, 'x');
	assert.equal(doc(view), '**h** x');
	view.destroy();
});

test('space, then moving the cursor away: the space stays outside', () => {
	const view = makeView('**hi**', 6);
	type(view, ' ');
	view.dispatch({ selection: { anchor: 0 } });
	view.dispatch({ selection: { anchor: 7 } });
	type(view, 'x');
	assert.equal(doc(view), '**hi** x');
	view.destroy();
});

test('Ctrl+B then a space first: the space is plain and bold waits for a letter', () => {
	const view = makeView('a', 1);
	toggleStyleAtCursor(view, 'strong');
	type(view, ' ');
	assert.equal(doc(view), 'a ');
	type(view, 'x');
	assert.equal(doc(view), 'a **x**');
	view.destroy();
});

test('spaces at the end of every style stay outside until a letter', () => {
	for (const kind of ['em', 'strike', 'highlight', 'code'] as const) {
		const view = makeView('', 0);
		toggleStyleAtCursor(view, kind);
		type(view, 'a');
		type(view, ' ');
		assert.equal(shownText(view), 'a ', kind);
		type(view, 'b');
		assert.equal(shownText(view), 'a b', kind);
		view.destroy();
	}
});

test('a space in the middle of a span is typed normally', () => {
	const view = makeView('**bold**', 4);
	type(view, ' ');
	assert.equal(doc(view), '**bo ld**');
	view.destroy();
});

// Links and wikilinks (step 5).

test('links show only their text', () => {
	const view = makeView('[text](http://x.io) and [[note]] and [[note|alias]] end');
	assert.equal(shownText(view), 'text and note and alias end');
	view.destroy();
});

test('embeds, images and plain brackets are left alone', () => {
	const text = '![[pic.png]] and ![alt](a.png) and [not a link] end';
	const view = makeView(text);
	assert.equal(shownText(view), text);
	view.destroy();
});

test('typing at either edge of a link goes outside it', () => {
	const end = makeView('[text](u) z', 5);
	type(end, 'X');
	assert.equal(doc(end), '[text](u)X z');
	end.destroy();

	const after = makeView('[text](u) z', 9);
	type(after, 'X');
	assert.equal(doc(after), '[text](u)X z');
	after.destroy();

	const start = makeView('[text](u) z', 1);
	type(start, 'X');
	assert.equal(doc(start), 'X[text](u) z');
	start.destroy();

	const wiki = makeView('[[note]]', 6);
	type(wiki, 'X');
	assert.equal(doc(wiki), '[[note]]X');
	wiki.destroy();
});

test('typing inside link text edits it', () => {
	const view = makeView('[text](u)', 3);
	type(view, 'X');
	assert.equal(doc(view), '[teXxt](u)');
	view.destroy();
});

test('arrow keys skip the hidden parts of a link', () => {
	const view = makeView('[ab](u)c', 0);
	const stops: number[] = [];
	for (let i = 0; i < 3; i++) {
		press(view, 'ArrowRight');
		stops.push(cursor(view));
	}
	assert.deepEqual(stops, [2, 7, 8]);
	view.destroy();
});

test('Backspace after a link deletes its last letter; the last one removes the link', () => {
	const view = makeView('[ab](u) c', 7);
	press(view, 'Backspace');
	assert.equal(doc(view), '[a](u) c');
	press(view, 'Backspace');
	assert.equal(doc(view), ' c');
	view.destroy();
});

/** Clicks the element holding `text` and tells whether Obsidian would see it. */
function clickReachesObsidian(view: EditorView, text: string, init: MouseEventInit = {}): boolean {
	let reached = false;
	const listener = () => (reached = true);
	view.dom.addEventListener('click', listener);
	const walker = document.createTreeWalker(view.contentDOM, 4 /* NodeFilter.SHOW_TEXT */);
	let node: Node | null;
	while ((node = walker.nextNode())) {
		if (node.textContent?.includes(text)) break;
	}
	assert.ok(node?.parentElement, `no element with ${text}`);
	node.parentElement.dispatchEvent(new window.MouseEvent('click', { bubbles: true, button: 0, ...init }));
	view.dom.removeEventListener('click', listener);
	return reached;
}

test('a plain click on link text does not open it; Ctrl/Cmd+click does', () => {
	const view = makeView('see [link](http://x.io) or plain');
	assert.equal(clickReachesObsidian(view, 'link'), false);
	assert.equal(clickReachesObsidian(view, 'link', { ctrlKey: true }), true);
	assert.equal(clickReachesObsidian(view, 'link', { metaKey: true }), true);
	assert.equal(clickReachesObsidian(view, 'plain'), true);
	view.destroy();

	const wiki = makeView('go [[note]] now');
	assert.equal(clickReachesObsidian(wiki, 'note'), false);
	wiki.destroy();

	const off = makeView('see [link](http://x.io)', 0, false);
	assert.equal(clickReachesObsidian(off, 'link'), true);
	off.destroy();
});

test('the link popup edits the link under the cursor', () => {
	const view = makeView('[text](http://x.io) after', 3);
	const ctx = linkContext(view);
	assert.ok(ctx);
	assert.equal(ctx.text, 'text');
	assert.equal(ctx.target, 'http://x.io');
	assert.equal(ctx.kind, 'markdown');
	applyLinkEdit(view, ctx, 'new', 'https://y.io');
	assert.equal(doc(view), '[new](https://y.io) after');
	assert.equal(shownText(view), 'new after');
	view.destroy();

	const wiki = makeView('a [[note|alias]] b', 10);
	const wctx = linkContext(wiki);
	assert.deepEqual([wctx?.text, wctx?.target, wctx?.kind], ['alias', 'note', 'wiki']);
	applyLinkEdit(wiki, wctx!, 'shown', 'Other');
	assert.equal(doc(wiki), 'a [[Other|shown]] b');
	wiki.destroy();
});

test('an empty target in the popup removes the link and keeps the text', () => {
	const view = makeView('[text](http://x.io) after', 3);
	applyLinkEdit(view, linkContext(view)!, 'text', '');
	assert.equal(doc(view), 'text after');
	view.destroy();
});

test('with a selection and no link, the popup creates one', () => {
	const view = makeView('a word b', 0);
	view.dispatch({ selection: { anchor: 2, head: 6 } });
	const ctx = linkContext(view)!;
	assert.equal(ctx.link, null);
	assert.equal(ctx.text, 'word');
	applyLinkEdit(view, ctx, ctx.text, 'My note');
	assert.equal(doc(view), 'a [[My note|word]] b');
	assert.equal(shownText(view), 'a word b');
	view.destroy();

	const url = makeView('a word b', 0);
	url.dispatch({ selection: { anchor: 2, head: 6 } });
	applyLinkEdit(url, linkContext(url)!, 'word', 'https://x.io');
	assert.equal(doc(url), 'a [word](https://x.io) b');
	url.destroy();
});

test('with Live Read off or outside Live Preview, Obsidian handles Ctrl+K', () => {
	const off = makeView('[text](u)', 3, false);
	assert.equal(linkContext(off), null);
	off.destroy();

	const source = makeView('[text](u)', 3);
	source.dispatch({ effects: setLivePreview.of(false) });
	assert.equal(linkContext(source), null);
	source.destroy();
});

// Block markers (step 6).

const has = (view: EditorView, selector: string) => view.contentDOM.querySelector(selector) !== null;

test('a heading hides its # even with the cursor on it', () => {
	const view = makeView('## Title', 8);
	assert.equal(shownText(view), 'Title');
	view.destroy();
	// No text yet: the # stays, so you can see you are making a heading.
	const empty = makeView('# ', 2);
	assert.equal(shownText(empty), '# ');
	empty.destroy();
});

test('bullets, numbers, checkboxes and quotes are drawn like Obsidian draws them', () => {
	const view = makeView('- item\n1. one\n- [ ] todo\n> quote\n>> deep', 3);
	assert.ok(has(view, '.list-bullet'), 'bullet');
	// Like Obsidian, the bullet is a class on the "-" itself, not a separate
	// element, so it keeps the list marker's indentation.
	assert.equal(view.contentDOM.querySelector('.list-bullet')?.textContent, '-');
	assert.notEqual(view.contentDOM.querySelector('.list-bullet')?.getAttribute('contenteditable'), 'false');
	assert.ok(has(view, '.list-number'), 'number');
	assert.ok(has(view, 'input.task-list-item-checkbox'), 'checkbox');
	assert.ok(has(view, '.cm-transparent'), 'first quote level');
	assert.ok(has(view, '.cm-blockquote-border'), 'nested quote level');
	view.destroy();
});

test('callout lines get no quote bar from the block marker handling', () => {
	const view = makeView('> [!NOTE] Title\n> body', 3);
	assert.equal(has(view, '.cm-transparent'), false);
	// Step 9 draws the callout itself: its markers are hidden.
	assert.equal(shownText(view), 'Titlebody');
	view.destroy();
});

test('with Live Read off, nothing is drawn', () => {
	const view = makeView('- item', 3, false);
	assert.equal(has(view, '.list-bullet'), false);
	view.destroy();
});

test('clicking a checkbox toggles it in the text', () => {
	const view = makeView('- [ ] todo', 0);
	const box = view.contentDOM.querySelector('input.task-list-item-checkbox') as HTMLInputElement;
	assert.equal(box.checked, false);
	box.checked = true;
	box.dispatchEvent(new window.Event('change'));
	assert.equal(doc(view), '- [x] todo');
	const again = view.contentDOM.querySelector('input.task-list-item-checkbox') as HTMLInputElement;
	assert.equal(again.checked, true);
	again.checked = false;
	again.dispatchEvent(new window.Event('change'));
	assert.equal(doc(view), '- [ ] todo');
	view.destroy();
});

test('typing at the start of a line goes after its marker', () => {
	const view = makeView('- ab', 0);
	type(view, 'X');
	assert.equal(doc(view), '- Xab');
	view.destroy();
});

test('arrow keys jump over block markers', () => {
	const view = makeView('x\n- ab', 1);
	press(view, 'ArrowRight');
	assert.equal(cursor(view), 4);
	press(view, 'ArrowLeft');
	assert.equal(cursor(view), 1);
	view.destroy();
});

test('Backspace at the start of the text turns the line into plain text', () => {
	for (const [text, pos, out] of [
		['- ab', 2, 'ab'],
		['## Title', 3, 'Title'],
		['- [ ] do', 6, 'do'],
		['> q', 2, 'q'],
		['1. one', 3, 'one'],
		['x\n\t- ab', 5, 'x\nab'],
	] as const) {
		const view = makeView(text, pos);
		press(view, 'Backspace');
		assert.equal(doc(view), out, text);
		view.destroy();
	}
});

test('Backspace in the middle of item text works as usual', () => {
	const view = makeView('- abc', 4);
	press(view, 'Backspace');
	assert.equal(doc(view), '- ac');
	view.destroy();
});

test('Delete at the end of a line joins the next item text without its marker', () => {
	const view = makeView('x\n- ab', 1);
	press(view, 'Delete');
	assert.equal(doc(view), 'xab');
	view.destroy();
});

test('bold at the start of a list item: Backspace removes the bullet, not the stars', () => {
	const view = makeView('- **b**', 4);
	press(view, 'Backspace');
	assert.equal(doc(view), '**b**');
	view.destroy();
});

// Code blocks (step 8).

const CODE_DOC = 'a\n```js\ncode\n```\nb';

test('fence lines are hidden, even with the cursor inside the block', () => {
	const view = makeView(CODE_DOC, 10);
	assert.equal(view.contentDOM.textContent?.includes('```'), false);
	assert.ok(view.state.doc.toString().includes('```js'));
	view.destroy();
});

test('a language label shows at the top of the block', () => {
	const view = makeView(CODE_DOC, 10);
	const label = view.contentDOM.querySelector('.code-block-flair.live-read-lang');
	assert.equal(label?.textContent, 'js');
	view.destroy();
	const plain = makeView('```\nx\n```', 4);
	assert.equal(plain.contentDOM.querySelector('.live-read-lang')?.textContent, 'plain text');
	plain.destroy();
});

test('clicking the label changes the language', () => {
	let asked = '';
	const view = makeView(CODE_DOC, 10, true, {
		pickLanguage: (current, apply) => {
			asked = current;
			apply('python');
		},
	});
	const label = view.contentDOM.querySelector('.live-read-lang') as HTMLElement;
	label.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	assert.equal(asked, 'js');
	assert.equal(doc(view), 'a\n```python\ncode\n```\nb');
	assert.equal(view.contentDOM.querySelector('.live-read-lang')?.textContent, 'python');
	view.destroy();
});

test('~~~ fences behave the same', () => {
	const view = makeView('~~~sql\nselect 1\n~~~', 8);
	assert.equal(view.contentDOM.textContent?.includes('~~~'), false);
	assert.equal(view.contentDOM.querySelector('.live-read-lang')?.textContent, 'sql');
	view.destroy();
});

test('a block still being written keeps its fences visible', () => {
	const view = makeView('```js\ncode', 8);
	assert.ok(view.contentDOM.textContent?.includes('```js'));
	view.destroy();
});

test('typing ``` on an empty line makes a block with the cursor inside', () => {
	const view = makeView('a\n``', 4);
	type(view, '`');
	assert.equal(doc(view), 'a\n```\n\n```');
	assert.equal(cursor(view), 6);
	type(view, 'x');
	assert.equal(doc(view), 'a\n```\nx\n```');
	view.destroy();
});

test('typing ``` to close a block written by hand closes it', () => {
	const view = makeView('```js\ncode\n``', 13);
	type(view, '`');
	assert.equal(doc(view), '```js\ncode\n```');
	view.destroy();
});

test('Backspace in an empty block removes the whole block', () => {
	const view = makeView('a\n```\n\n```\nb', 6);
	press(view, 'Backspace');
	assert.equal(doc(view), 'a\n\nb');
	assert.equal(cursor(view), 2);
	view.destroy();
});

test('Backspace at the start of the code does not join it into the fence', () => {
	const view = makeView(CODE_DOC, 8);
	press(view, 'Backspace');
	assert.equal(doc(view), CODE_DOC);
	view.destroy();
});

test('arrow keys go in and out of the code without stopping on fences', () => {
	const view = makeView(CODE_DOC, 1);
	press(view, 'ArrowRight');
	assert.equal(cursor(view), 8);
	press(view, 'ArrowLeft');
	assert.equal(cursor(view), 1);
	view.dispatch({ selection: { anchor: 12 } });
	press(view, 'ArrowRight');
	assert.equal(cursor(view), 17);
	press(view, 'ArrowLeft');
	assert.equal(cursor(view), 12);
	view.destroy();
});

test('typing on a hidden fence line goes into the code', () => {
	const view = makeView(CODE_DOC, 2);
	type(view, 'x');
	assert.equal(doc(view), 'a\n```js\nxcode\n```\nb');
	view.destroy();
});

test('code is edited as usual', () => {
	const view = makeView(CODE_DOC, 10);
	type(view, '*');
	press(view, 'Backspace');
	press(view, 'Backspace');
	assert.equal(doc(view), 'a\n```js\ncde\n```\nb');
	view.destroy();
});

test('with Live Read off, code blocks are left alone', () => {
	const view = makeView(CODE_DOC, 10, false);
	assert.ok(view.contentDOM.textContent?.includes('```js'));
	assert.equal(view.contentDOM.querySelector('.live-read-lang'), null);
	view.destroy();
});

// Callouts (step 9).

const lineEls = (view: EditorView) => Array.from(view.contentDOM.querySelectorAll('.cm-line')) as HTMLElement[];

test('a callout is drawn with Obsidian classes, even with the cursor inside', () => {
	const view = makeView('> [!tip] Title\n> body', 17);
	const [head, body] = lineEls(view);
	assert.ok(head?.classList.contains('callout') && head.classList.contains('live-read-callout-title'));
	assert.equal(head?.getAttribute('data-callout'), 'tip');
	assert.ok(body?.classList.contains('live-read-callout-last'));
	assert.equal(view.contentDOM.querySelector('.live-read-callout-icon')?.getAttribute('data-icon'), 'lucide-flame');
	// "> [!tip] " and "> " are hidden; the title and body are shown as text.
	assert.equal(view.contentDOM.textContent, 'Titlebody');
	view.destroy();
});

test('an empty title shows the type name', () => {
	const view = makeView('> [!warning]\n> x', 14);
	assert.equal(view.contentDOM.querySelector('.live-read-callout-placeholder')?.textContent, 'Warning');
	view.destroy();
});

test('clicking the icon changes the type', () => {
	let asked = '';
	const view = makeView('> [!note] T\n> b', 13, true, {
		pickCalloutType: (current, apply) => {
			asked = current;
			apply('warning');
		},
	});
	(view.contentDOM.querySelector('.live-read-callout-icon') as HTMLElement).dispatchEvent(
		new window.MouseEvent('click', { bubbles: true }),
	);
	assert.equal(asked, 'note');
	assert.equal(doc(view), '> [!warning] T\n> b');
	view.destroy();
});

test('the fold arrow switches - and +', () => {
	const view = makeView('> [!note]- T\n> b', 14);
	const fold = view.contentDOM.querySelector('.live-read-callout-fold') as HTMLElement;
	assert.ok(fold.classList.contains('is-collapsed'));
	fold.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	assert.equal(doc(view), '> [!note]+ T\n> b');
	view.destroy();
	const plain = makeView('> [!note] T\n> b', 13);
	assert.equal(plain.contentDOM.querySelector('.live-read-callout-fold'), null);
	plain.destroy();
});

test('typing at the start of a callout line goes after its hidden marker', () => {
	const view = makeView('> [!note] T\n> body', 12);
	type(view, 'X');
	assert.equal(doc(view), '> [!note] T\n> Xbody');
	view.destroy();
});

test('arrow keys skip the hidden markers', () => {
	const view = makeView('> [!note] T\n> body', 11);
	press(view, 'ArrowRight');
	assert.equal(cursor(view), 14);
	press(view, 'ArrowLeft');
	assert.equal(cursor(view), 11);
	view.destroy();
});

test('Backspace at the start of a body line joins it to the line above', () => {
	const view = makeView('> [!note] T\n> body', 14);
	press(view, 'Backspace');
	assert.equal(doc(view), '> [!note] Tbody');
	view.destroy();
});

test('Backspace at the start of an empty callout turns it into plain text', () => {
	const view = makeView('a\n> [!note]\n> \nb', 11);
	press(view, 'Backspace');
	assert.equal(doc(view), 'a\n\nb');
	view.destroy();
});

test('Backspace at the start of a non-empty title keeps the callout', () => {
	const view = makeView('> [!note] T\n> b', 10);
	press(view, 'Backspace');
	assert.equal(doc(view), '> [!note] T\n> b');
	view.destroy();
});

test('nested callouts, callouts in code blocks, and Live Read off: left alone', () => {
	for (const [text, on] of [
		['> [!note] A\n> > [!tip] B', true],
		['```\n> [!note] x\n```', true],
		['> [!note] x', false],
	] as const) {
		const view = makeView(text, 0, on);
		assert.equal(view.contentDOM.querySelector('.live-read-callout'), null, text);
		view.destroy();
	}
});

test('clicking the rendered callout from Obsidian puts the cursor where you click', () => {
	const view = makeView('> [!tip] My title\n> first line\n> second\n\nafter', 45);
	// A stand-in for Obsidian's rendered callout box, at the top of the note.
	const box = document.createElement('div');
	box.className = 'cm-embed-block cm-callout';
	box.innerHTML =
		'<div class="callout"><div class="callout-title"><div class="callout-title-inner">My title</div></div>' +
		'<div class="callout-content"><p>first line<br>second</p></div></div>';
	view.contentDOM.insertBefore(box, view.contentDOM.firstChild);
	let reachedObsidian = false;
	box.addEventListener('mousedown', () => (reachedObsidian = true));
	box.addEventListener('click', () => (reachedObsidian = true));

	const title = box.querySelector('.callout-title-inner')!;
	title.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
	title.dispatchEvent(new window.MouseEvent('click', { bubbles: true, button: 0 }));
	// No caret info in this test browser: the start of what was clicked.
	assert.equal(cursor(view), doc(view).indexOf('My title'));
	assert.equal(view.state.selection.main.empty, true);
	assert.equal(reachedObsidian, false);

	const body = box.querySelector('.callout-content p')!;
	body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
	assert.equal(cursor(view), doc(view).indexOf('first line'));

	// Ctrl+click is left to Obsidian.
	title.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0, ctrlKey: true }));
	assert.equal(reachedObsidian, true);
	box.remove();
	view.destroy();
});

test('paragraph spacing classes: above the first, below the last, one gap between', () => {
	const view = makeView('> [!note] T\n> one\n> still one\n> \n> two', 13);
	const classes = lineEls(view).map((el) =>
		['p-first', 'p-last', 'gap'].filter((k) => el.classList.contains(`live-read-callout-${k}`)).join(','),
	);
	assert.deepEqual(classes, ['', 'p-first', '', 'gap', 'p-last']);
	view.destroy();
});
