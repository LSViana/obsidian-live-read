// Stand-in for the parts of the obsidian module the link popup uses.
// Built on the fake browser page from setup-dom.

export interface SearchResult {
	score: number;
	matches: [number, number][];
}

/** Letters in order, fewer gaps score higher (like Obsidian's quick switcher). */
export function prepareFuzzySearch(query: string) {
	const q = query.toLowerCase().replace(/\s+/g, '');
	return (text: string): SearchResult | null => {
		const t = text.toLowerCase();
		let at = -1;
		let gaps = 0;
		for (const ch of q) {
			const i = t.indexOf(ch, at + 1);
			if (i < 0) return null;
			if (at >= 0) gaps += i - at - 1;
			at = i;
		}
		return { score: -gaps, matches: [] };
	};
}

export function renderResults(el: HTMLElement, text: string) {
	el.textContent = text;
}

export function parseFrontMatterAliases(frontmatter: { aliases?: string[] } | null | undefined): string[] | null {
	return frontmatter?.aliases ?? null;
}

export class TextComponent {
	inputEl = document.createElement('input');
	private change: ((v: string) => void) | null = null;
	constructor() {
		this.inputEl.addEventListener('input', () => this.change?.(this.inputEl.value));
	}
	setValue(v: string) {
		this.inputEl.value = v;
		return this;
	}
	getValue() {
		return this.inputEl.value;
	}
	setPlaceholder(v: string) {
		this.inputEl.placeholder = v;
		return this;
	}
	onChange(cb: (v: string) => void) {
		this.change = cb;
		return this;
	}
}

export class ButtonComponent {
	buttonEl = document.createElement('button');
	setButtonText(t: string) {
		this.buttonEl.textContent = t;
		return this;
	}
	setCta() {
		return this;
	}
	onClick(cb: () => void) {
		this.buttonEl.addEventListener('click', cb);
		return this;
	}
}

export class Setting {
	constructor(private readonly containerEl: HTMLElement) {}
	setName() {
		return this;
	}
	setDesc() {
		return this;
	}
	addText(cb: (t: TextComponent) => void) {
		const t = new TextComponent();
		this.containerEl.appendChild(t.inputEl);
		cb(t);
		return this;
	}
	addButton(cb: (b: ButtonComponent) => void) {
		const b = new ButtonComponent();
		this.containerEl.appendChild(b.buttonEl);
		cb(b);
		return this;
	}
}

export class Modal {
	contentEl = Object.assign(document.createElement('div'), {
		// Obsidian adds empty() to every element.
		empty(this: HTMLElement) {
			this.replaceChildren();
		},
	});
	titleEl = Object.assign(document.createElement('div'), {
		setText(this: HTMLElement, t: string) {
			this.textContent = t;
		},
	});
	constructor(readonly app: unknown) {}
	open() {
		document.body.appendChild(this.contentEl);
		(this as unknown as { onOpen(): void }).onOpen();
	}
	close() {
		this.contentEl.remove();
		(this as unknown as { onClose(): void }).onClose();
	}
}

/** Every suggest created, so tests can type into it and pick from it. */
export const suggests: AbstractInputSuggest<unknown>[] = [];

export abstract class AbstractInputSuggest<T> {
	limit = 100;
	select: ((value: T, evt: Event) => void) | null = null;
	constructor(
		readonly app: unknown,
		readonly inputEl: HTMLInputElement,
	) {
		suggests.push(this as AbstractInputSuggest<unknown>);
	}
	protected abstract getSuggestions(query: string): T[];
	/** Test helper: what the list shows for the current input value. */
	suggestionsNow(): T[] {
		return this.getSuggestions(this.inputEl.value);
	}
	onSelect(cb: (value: T, evt: Event) => void) {
		this.select = cb;
		return this;
	}
}

export type TFile = { path: string; basename: string };
export type App = unknown;
