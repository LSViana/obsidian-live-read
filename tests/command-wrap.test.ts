import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STYLE_COMMANDS, wrapStyleCommands } from '../src/command-wrap.ts';

function fakeApp() {
	const calls: string[] = [];
	const commands: Record<string, { editorCallback?: (e: unknown, c: unknown) => unknown }> = {};
	for (const id of Object.keys(STYLE_COMMANDS)) {
		commands[id] = { editorCallback: (editor) => calls.push(`${id}:${String(editor)}`) };
	}
	commands['editor:toggle-highlight-red'] = { editorCallback: () => calls.push('red') };
	return { app: { commands: { commands } }, commands, calls };
}

test('wraps the five style commands with the right style', () => {
	const { app, commands } = fakeApp();
	const seen: string[] = [];
	wrapStyleCommands(app, (_editor, kind) => {
		seen.push(kind);
		return true;
	});
	for (const id of Object.keys(STYLE_COMMANDS)) commands[id]!.editorCallback!('ed', {});
	assert.deepEqual(seen, ['strong', 'em', 'strike', 'highlight', 'code']);
});

test('when Live Read handles it, Obsidian code does not run', () => {
	const { app, commands, calls } = fakeApp();
	wrapStyleCommands(app, () => true);
	commands['editor:toggle-bold']!.editorCallback!('ed', {});
	assert.deepEqual(calls, []);
});

test('when Live Read declines, Obsidian code runs with the same editor', () => {
	const { app, commands, calls } = fakeApp();
	wrapStyleCommands(app, () => false);
	commands['editor:toggle-bold']!.editorCallback!('ed', {});
	assert.deepEqual(calls, ['editor:toggle-bold:ed']);
});

test('other commands are left alone', () => {
	const { app, commands, calls } = fakeApp();
	const before = commands['editor:toggle-highlight-red']!.editorCallback;
	wrapStyleCommands(app, () => true);
	assert.equal(commands['editor:toggle-highlight-red']!.editorCallback, before);
	commands['editor:toggle-highlight-red']!.editorCallback!('ed', {});
	assert.deepEqual(calls, ['red']);
});

test('unloading puts the original commands back', () => {
	const { app, commands } = fakeApp();
	const originals = Object.keys(STYLE_COMMANDS).map((id) => commands[id]!.editorCallback);
	const restore = wrapStyleCommands(app, () => true);
	restore();
	assert.deepEqual(
		Object.keys(STYLE_COMMANDS).map((id) => commands[id]!.editorCallback),
		originals,
	);
});

test('after unloading, a wrapper someone else kept in the chain just passes through', () => {
	const { app, commands, calls } = fakeApp();
	const restore = wrapStyleCommands(app, () => true);
	const ours = commands['editor:toggle-bold']!.editorCallback!;
	// Another plugin wraps on top of ours.
	commands['editor:toggle-bold']!.editorCallback = (e, c) => ours(e, c);
	restore();
	commands['editor:toggle-bold']!.editorCallback!('ed', {});
	assert.deepEqual(calls, ['editor:toggle-bold:ed']);
});

test('a missing registry or command does not throw', () => {
	assert.doesNotThrow(() => wrapStyleCommands({}, () => true)());
	assert.doesNotThrow(() => wrapStyleCommands({ commands: { commands: {} } }, () => true)());
});
