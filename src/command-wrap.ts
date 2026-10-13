// Takes over Obsidian's built-in style toggles (Ctrl+B, Ctrl+I, ...) while
// the plugin is loaded. Obsidian runs its own Ctrl+B before any plugin
// command or editor keymap sees the key, so wrapping the command is the only
// way to change what it does. Each wrapper asks `handle` first and falls back
// to Obsidian's original code when `handle` returns false.
//
// This uses app.commands, which is not part of Obsidian's public API.
import type { Kind } from './hidden-ranges.ts';

export const STYLE_COMMANDS: Readonly<Record<string, Kind>> = {
	'editor:toggle-bold': 'strong',
	'editor:toggle-italics': 'em',
	'editor:toggle-strikethrough': 'strike',
	'editor:toggle-highlight': 'highlight',
	'editor:toggle-code': 'code',
};

type EditorCallback = (editor: unknown, ctx: unknown) => unknown;

interface CommandLike {
	editorCallback?: EditorCallback;
}

interface AppLike {
	commands?: { commands?: Record<string, CommandLike | undefined> };
}

/**
 * Wraps the style commands. Returns a function that puts the originals back.
 * Commands that are missing or have an unexpected shape are left alone.
 */
export function wrapStyleCommands(
	app: unknown,
	handle: (editor: unknown, kind: Kind) => boolean,
): () => void {
	const registry = (app as AppLike).commands?.commands;
	if (!registry) return () => {};
	let disposed = false;
	const restores: (() => void)[] = [];

	for (const [id, kind] of Object.entries(STYLE_COMMANDS)) {
		const command = registry[id];
		const original = command?.editorCallback;
		if (!command || typeof original !== 'function') continue;
		const wrapped: EditorCallback = function (this: unknown, editor, ctx) {
			if (!disposed && handle(editor, kind)) return;
			return original.call(this, editor, ctx);
		};
		command.editorCallback = wrapped;
		restores.push(() => {
			// If another plugin wrapped it after us, leave its wrapper in
			// place; ours then just passes through because `disposed` is set.
			if (command.editorCallback === wrapped) command.editorCallback = original;
		});
	}

	return () => {
		disposed = true;
		for (const restore of restores) restore();
	};
}
