import { type App, Modal, Setting } from 'obsidian';

export interface LinkModalInput {
	editing: boolean;
	text: string;
	target: string;
}

/** Small popup to edit or add a link: its text and what it points to. */
export class LinkModal extends Modal {
	private submitted = false;

	constructor(
		app: App,
		private readonly input: LinkModalInput,
		private readonly onSubmit: (text: string, target: string) => void,
		private readonly onDone: () => void,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl, input } = this;
		this.titleEl.setText(input.editing ? 'Edit link' : 'Add link');
		let text = input.text;
		let target = input.target;
		const submit = () => {
			this.submitted = true;
			this.close();
			this.onSubmit(text, target);
		};

		let focusEl: HTMLInputElement | null = null;
		new Setting(contentEl).setName('Text').addText((field) => {
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
			});
		new Setting(contentEl)
			.addButton((b) => b.setButtonText('Save').setCta().onClick(submit))
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));

		contentEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.isComposing) {
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
