import { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { Notice, Plugin } from 'obsidian';
import { wrapStyleCommands } from './command-wrap';
import { liveReadExtension, toggleStyleAtCursor } from './extension';
import { DEFAULT_SETTINGS, LiveReadSettings } from './settings';

export default class LiveReadPlugin extends Plugin {
	settings: LiveReadSettings = { ...DEFAULT_SETTINGS };

	// Obsidian keeps a reference to this array. We change its contents and
	// call updateOptions() so open editors pick up the change.
	private editorExtensions: Extension[] = [];
	private statusBarEl: HTMLElement | null = null;

	async onload() {
		await this.loadSettings();

		this.registerEditorExtension(this.editorExtensions);

		this.addCommand({
			id: 'toggle',
			name: 'Toggle Live Read',
			hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'l' }],
			callback: () => this.setEnabled(!this.settings.enabled),
		});

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass('mod-clickable');
		this.registerDomEvent(this.statusBarEl, 'click', () =>
			this.setEnabled(!this.settings.enabled),
		);

		this.applyState();

		// Ctrl+B, Ctrl+I and the other style toggles: Live Read behavior with
		// no selection, Obsidian's own behavior otherwise.
		this.register(
			wrapStyleCommands(this.app, (editor, kind) => {
				if (!this.settings.enabled) return false;
				const view = (editor as { cm?: unknown } | null)?.cm;
				return view instanceof EditorView && toggleStyleAtCursor(view, kind);
			}),
		);
	}

	async setEnabled(enabled: boolean) {
		this.settings.enabled = enabled;
		await this.saveSettings();
		this.applyState();
		new Notice(`Live Read ${enabled ? 'on' : 'off'}`);
	}

	private applyState() {
		this.editorExtensions.length = 0;
		if (this.settings.enabled) {
			this.editorExtensions.push(...this.buildExtensions());
		}
		this.app.workspace.updateOptions();
		this.updateStatusBar();
	}

	private buildExtensions(): Extension[] {
		return liveReadExtension();
	}

	private updateStatusBar() {
		if (!this.statusBarEl) return;
		const on = this.settings.enabled;
		this.statusBarEl.setText(`Live Read: ${on ? 'on' : 'off'}`);
		this.statusBarEl.setAttr('aria-label', 'Click to toggle Live Read');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
