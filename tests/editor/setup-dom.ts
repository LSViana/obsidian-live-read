// Gives Node a fake browser page so a real CodeMirror editor can run.
// Imported first by the editor test.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const win = dom.window as unknown as Record<string, unknown>;
const g = globalThis as unknown as Record<string, unknown>;

for (const key of [
	'window',
	'document',
	'navigator',
	'MutationObserver',
	'HTMLElement',
	'Element',
	'Node',
	'Text',
	'Range',
	'DOMRect',
	'KeyboardEvent',
	'getComputedStyle',
	'requestAnimationFrame',
	'cancelAnimationFrame',
	'getSelection',
]) {
	const value = key === 'window' ? dom.window : win[key];
	Object.defineProperty(g, key, {
		value: typeof value === 'function' && /^[a-z]/.test(key) ? value.bind(dom.window) : value,
		configurable: true,
		writable: true,
	});
}

// jsdom has no layout. CodeMirror asks for rectangles; give it empty ones.
const emptyRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
const RangeProto = (dom.window.Range as unknown as { prototype: Record<string, unknown> }).prototype;
RangeProto.getClientRects = () => [];
RangeProto.getBoundingClientRect = emptyRect;
