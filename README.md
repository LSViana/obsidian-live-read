# Live Read

An Obsidian plugin that works on top of Live Preview. When it is on, inline
markdown markers (bold, italic, strike, highlight, inline code) stay hidden even
when the cursor is on them, so you edit the rendered text directly.

Desktop only for now.

## Use

- Command: "Live Read: Toggle Live Read". Default hotkey: Ctrl+Shift+L
  (Cmd+Shift+L on macOS). Ctrl+Alt+L was avoided because on some keyboard
  layouts Ctrl+Alt acts as AltGr and types a character. You can change it in
  Settings > Hotkeys.
- Or click "Live Read: on/off" in the status bar.

The on/off state is global and is saved in the plugin settings.
It only has an effect in Live Preview, not in Source mode or Reading view.

## How editing works

- Markers of bold, italic, strike, highlight and inline code stay hidden even
  when the cursor is on them. A marker is only hidden once its closing side is
  typed, so `**` you are still typing stays visible.
- Typing at the end of a styled span stays inside it. Typing at the start goes
  outside it (same as Obsidian and Typora).
- Arrow keys move one visible letter per press. They do not stop twice at a
  hidden marker.
- Backspace and Delete next to a hidden marker delete the nearby letter, not
  the marker. Deleting the last letter of a span also removes its markers.

Not covered yet: headings, lists, quotes, links, code blocks, math, callouts.
A style that spans more than one line keeps its markers visible.

## Build

```
npm install
npm run build   # type check + bundle to main.js
npm run dev     # rebuild on every change
npm test        # unit tests, then editor tests in a real CodeMirror editor
```

`main.js` is a build output and is not tracked in Git. After checking out an
older commit, run `npm run build` again so Obsidian loads that version.
