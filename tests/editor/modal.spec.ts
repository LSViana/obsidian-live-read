// Runs the link popup with a stand-in for Obsidian's Modal, Setting and
// suggestion classes, to check the note list and what picking does.
import './setup-dom';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkModal } from '../../src/link-modal';
import { suggests } from './obsidian-modal-mock';

interface Note {
	path: string;
	aliases?: string[];
}

function fakeApp(notes: Note[]) {
	const files = notes.map((n) => ({ path: n.path, basename: n.path.replace(/^.*\//, '').replace(/\.md$/, '') }));
	return {
		vault: { getMarkdownFiles: () => files },
		metadataCache: {
			fileToLinktext: (f: { basename: string }) => f.basename,
			getFileCache: (f: { path: string }) => ({
				frontmatter: { aliases: notes.find((n) => n.path === f.path)?.aliases },
			}),
		},
	};
}

const APP = fakeApp([
	{ path: 'Cards/Card 3.md' },
	{ path: 'Cards/Card 7.md', aliases: ['Seventh card'] },
	{ path: 'Project plan.md', aliases: ['Roadmap'] },
]);

interface Opened {
	text: HTMLInputElement;
	target: HTMLInputElement;
	modal: LinkModal;
	submitted: { text: string; target: string; kind?: string }[];
}

function open(text: string, target: string, editing = false): Opened {
	suggests.length = 0;
	const submitted: Opened['submitted'] = [];
	const modal = new LinkModal(
		APP as never,
		{ editing, text, target, sourcePath: 'Live Read test.md' },
		(t, g, kind) => submitted.push({ text: t, target: g, kind }),
		() => {},
	);
	modal.open();
	const [textEl, targetEl] = Array.from(modal.contentEl.querySelectorAll('input'));
	return { text: textEl!, target: targetEl!, modal, submitted };
}

function typeInto(el: HTMLInputElement, value: string) {
	el.value = value;
	el.dispatchEvent(new window.Event('input'));
}

function suggestionLabels(): string[] {
	return (suggests[0]!.suggestionsNow() as { label: string }[]).map((s) => s.label);
}

function pick(label: string) {
	const s = suggests[0]!;
	const item = (s.suggestionsNow() as { label: string }[]).find((x) => x.label === label);
	assert.ok(item, `no suggestion ${label}`);
	const evt = new window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
	s.select!(item, evt);
	return evt;
}

function pressEnter(o: Opened, evt = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) {
	o.target.dispatchEvent(evt);
}

test('typing in "Link to" lists notes by name and by alias', () => {
	const o = open('', '');
	typeInto(o.target, 'card');
	assert.deepEqual(suggestionLabels().sort(), ['Card 3', 'Card 7', 'Seventh card']);
	typeInto(o.target, 'roadmap');
	assert.deepEqual(suggestionLabels(), ['Roadmap']);
	typeInto(o.target, 'https://card.io');
	assert.deepEqual(suggestionLabels(), []);
	o.modal.close();
});

test('picking a note fills "Link to" and an empty "Text", and saves a wikilink', () => {
	const o = open('', '');
	typeInto(o.target, 'c7');
	pick('Card 7');
	assert.equal(o.target.value, 'Card 7');
	assert.equal(o.text.value, 'Card 7');
	pressEnter(o);
	assert.deepEqual(o.submitted, [{ text: 'Card 7', target: 'Card 7', kind: 'wiki' }]);
});

test('picking an alias shows the alias as the text', () => {
	const o = open('', '');
	typeInto(o.target, 'seventh');
	pick('Seventh card');
	assert.equal(o.target.value, 'Card 7');
	assert.equal(o.text.value, 'Seventh card');
	pressEnter(o);
	assert.deepEqual(o.submitted, [{ text: 'Seventh card', target: 'Card 7', kind: 'wiki' }]);
});

test('picking keeps text the user selected or typed', () => {
	const o = open('my words', '');
	typeInto(o.target, 'roadmap');
	pick('Roadmap');
	assert.equal(o.text.value, 'my words');
	assert.equal(o.target.value, 'Project plan');
	o.modal.close();
});

test('editing [[Card 3]]: its text follows a new pick', () => {
	const o = open('Card 3', 'Card 3', true);
	typeInto(o.target, 'roadmap');
	pick('Roadmap');
	assert.equal(o.text.value, 'Roadmap');
	o.modal.close();
});

test('Enter that picks a suggestion does not also save', () => {
	const o = open('', '');
	typeInto(o.target, 'c3');
	const evt = pick('Card 3');
	assert.equal(evt.defaultPrevented, true);
	pressEnter(o, evt);
	assert.deepEqual(o.submitted, []);
	o.modal.close();
});

test('a typed web address still saves as before', () => {
	const o = open('site', '');
	typeInto(o.target, 'https://obsidian.md');
	pressEnter(o);
	assert.deepEqual(o.submitted, [{ text: 'site', target: 'https://obsidian.md', kind: undefined }]);
});

test('changing "Link to" after a pick drops the forced wikilink', () => {
	const o = open('', '');
	typeInto(o.target, 'c3');
	pick('Card 3');
	typeInto(o.target, 'https://x.io');
	pressEnter(o);
	assert.equal(o.submitted[0]?.kind, undefined);
});
