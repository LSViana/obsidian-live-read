// Stand-in for the parts of the obsidian module the editor extension uses.
import { StateEffect, StateField } from '@codemirror/state';

export const setLivePreview = StateEffect.define<boolean>();

export const editorLivePreviewField = StateField.define<boolean>({
	create: () => true,
	update: (value, tr) => {
		for (const e of tr.effects) if (e.is(setLivePreview)) return e.value;
		return value;
	},
});
