import {
	AbstractInputSuggest,
	type App,
	Modal,
	type SearchResult,
	Setting,
	type TextComponent,
	type TFile,
	parseFrontMatterAliases,
	prepareFuzzySearch,
	renderResults,
} from 'obsidian';
import type { LinkKind } from './links';
import { type NoteEntry, type NoteSuggestion, rankNotes, textForPick } from './note-suggest';

export interface LinkModalInput {
	editing: boolean;
	text: string;
	target: string;
	/** The note being edited, for the shortest link text to other notes. */
	sourcePath: string;
}

/** Vault notes with their aliases, as the suggestion list needs them. */
function vaultNotes(app: App, sourcePath: string): NoteEntry[] {
	return app.vault.getMarkdownFiles().map((file: TFile) => ({
		path: file.path,
		name: file.basename,
		linktext: app.metadataCache.fileToLinktext(file, sourcePath, true),
		aliases: parseFrontMatterAliases(app.metadataCache.getFileCache(file)?.frontmatter) ?? [],
	}));
}

/** Note suggestions under the "Link to" field, matched like the quick switcher. */
class NoteSuggest extends AbstractInputSuggest<NoteSuggestion<SearchResult>> {
	private notes: NoteEntry[] | null = null;

	constructor(
		app: App,
		inputEl: HTMLInputElement,
		private readonly sourcePath: string,
	) {
		super(app, inputEl);
		this.limit = 50;
	}

	protected getSuggestions(query: string): NoteSuggestion<SearchResult>[] {
		this.notes ??= vaultNotes(this.app, this.sourcePath);
		return rankNotes(query, this.notes, prepareFuzzySearch);
	}

	renderSuggestion(item: NoteSuggestion<SearchResult>, el: HTMLElement) {
		el.addClass('mod-complex');
		const content = el.createDiv('suggestion-content');
		renderResults(content.createDiv('suggestion-title'), item.label, item.match);
		content.createDiv('suggestion-note', (note) =>
			note.setText(item.alias ? `Alias of ${item.entry.linktext}` : item.entry.path),
		);
	}
}

/** Small popup to edit or add a link: its text and what it points to. */
export class LinkModal extends Modal {
	private submitted = false;

	constructor(
		app: App,
		private readonly input: LinkModalInput,
		/** `kind` is "wiki" when the target was picked from the note list. */
		private readonly onSubmit: (text: string, target: string, kind?: LinkKind) => void,
		private readonly onDone: () => void,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl, input } = this;
		this.titleEl.setText(input.editing ? 'Edit link' : 'Add link');
		let text = input.text;
		let target = input.target;
		// The note picked from the list, while "Link to" still holds it.
		let picked: string | null = null;
		// Values the popup put in "Text" itself; replacing them is fine.
		const untouched = [input.target];
		const submit = () => {
			this.submitted = true;
			this.close();
			this.onSubmit(text, target, picked !== null && picked === target ? 'wiki' : undefined);
		};

		let textField: TextComponent | null = null;
		let focusEl: HTMLInputElement | null = null;
		new Setting(contentEl).setName('Text').addText((field) => {
			textField = field;
			field.setValue(text).onChange((v) => (text = v));
			if (input.editing || !text) focusEl = field.inputEl;
		});
		new Setting(contentEl)
			.setName('Link to')
			.setDesc(
				input.editing
					? 'A web address or a note name. Leave it empty to remove the link and keep the text.'
					: 'A web address or a note name.',
			)
			.addText((field) => {
				field.setPlaceholder('https://... or Note name').setValue(target).onChange((v) => (target = v));
				if (!focusEl) focusEl = field.inputEl;
				new NoteSuggest(this.app, field.inputEl, input.sourcePath).onSelect((item, evt) => {
					target = item.entry.linktext;
					field.setValue(target);
					picked = target;
					const newText = textForPick(text, untouched, item);
					if (newText !== null && textField) {
						text = newText;
						(textField as TextComponent).setValue(newText);
						untouched.push(newText);
					}
					// Keep Enter from also saving the popup on the same key press.
					evt.preventDefault();
					field.inputEl.focus();
				});
			});
		new Setting(contentEl)
			.addButton((b) => b.setButtonText('Save').setCta().onClick(submit))
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));

		contentEl.addEventListener('keydown', (e) => {
			// Enter on a highlighted suggestion picks it (the suggestion list
			// handles that first); otherwise Enter saves.
			if (e.key === 'Enter' && !e.isComposing && !e.defaultPrevented) {
				e.preventDefault();
				submit();
			}
		});
		window.setTimeout(() => (focusEl as HTMLInputElement | null)?.select(), 0);
	}

	onClose() {
		this.contentEl.empty();
		if (!this.submitted) this.onDone();
	}
}
