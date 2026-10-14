import {
	AbstractInputSuggest,
	type App,
	Modal,
	type SearchResult,
	Setting,
	prepareFuzzySearch,
	renderResults,
} from 'obsidian';

/** Common code block languages, offered as suggestions. Any text is allowed. */
export const COMMON_LANGUAGES = [
	'bash',
	'c',
	'cpp',
	'csharp',
	'css',
	'dataview',
	'diff',
	'go',
	'html',
	'java',
	'javascript',
	'json',
	'kotlin',
	'markdown',
	'mermaid',
	'php',
	'powershell',
	'python',
	'ruby',
	'rust',
	'shell',
	'sql',
	'swift',
	'typescript',
	'xml',
	'yaml',
];

class LanguageSuggest extends AbstractInputSuggest<{ lang: string; match: SearchResult }> {
	protected getSuggestions(query: string) {
		const test = prepareFuzzySearch(query.trim());
		return COMMON_LANGUAGES.flatMap((lang) => {
			const match = query.trim() ? test(lang) : { score: 0, matches: [] };
			return match ? [{ lang, match }] : [];
		}).sort((a, b) => b.match.score - a.match.score);
	}

	renderSuggestion(item: { lang: string; match: SearchResult }, el: HTMLElement) {
		renderResults(el, item.lang, item.match);
	}
}

/** Small popup to change a code block's language. */
export class LanguageModal extends Modal {
	constructor(
		app: App,
		private readonly current: string,
		private readonly onSubmit: (lang: string) => void,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		this.titleEl.setText('Code block language');
		let lang = this.current;
		const submit = () => {
			this.close();
			this.onSubmit(lang);
		};
		let input: HTMLInputElement | null = null;
		new Setting(contentEl)
			.setName('Language')
			.setDesc('For example javascript or python. Leave it empty for plain text.')
			.addText((field) => {
				input = field.inputEl;
				field.setValue(lang).onChange((v) => (lang = v));
				new LanguageSuggest(this.app, field.inputEl).onSelect((item, evt) => {
					lang = item.lang;
					field.setValue(lang);
					evt.preventDefault();
					submit();
				});
			});
		new Setting(contentEl)
			.addButton((b) => b.setButtonText('Save').setCta().onClick(submit))
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
		contentEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.isComposing && !e.defaultPrevented) {
				e.preventDefault();
				submit();
			}
		});
		window.setTimeout(() => (input as HTMLInputElement | null)?.select(), 0);
	}

	onClose() {
		this.contentEl.empty();
	}
}
