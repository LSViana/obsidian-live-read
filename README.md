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

## Style toggles (Ctrl+B, Ctrl+I, ...)

While Live Read is on, Obsidian's own toggle commands for bold (Ctrl+B),
italic (Ctrl+I), strikethrough, highlight and inline code work like Notion:

- With text selected: Obsidian wraps or unwraps the selection, as usual.
- With no selection: press once and the next letters you type get the style.
  Press again to stop. Nothing is written to the file until you type, and
  moving the cursor first cancels it.
- Inside a styled span: pressing the toggle closes the span at the cursor,
  so the next letters are plain.
- Spaces typed at the end of a styled span go just after its closing marker
  until a letter follows, because markdown does not accept `**word **` as
  bold. The letter then joins the span, spaces included. If you move the
  cursor away first, the spaces stay outside.

Strikethrough, highlight and code have no default hotkey in Obsidian; bind
them in Settings > Hotkeys if you want. When Live Read is off, or outside Live
Preview, the commands behave exactly as Obsidian's defaults.

The plugin does this by wrapping Obsidian's built-in commands
(`editor:toggle-bold` and the others) while it is loaded, because Obsidian
handles Ctrl+B before any plugin hotkey or editor keymap can. This relies on
`app.commands`, which is not public API. Unloading the plugin restores them.

## Links

While Live Read is on, `[text](url)`, `[[note]]` and `[[note|alias]]` show only
their text (the note name, or the alias), even under the cursor. Embeds
(`![[...]]`) and images are left to Obsidian.

- Click link text to put the cursor there and edit it. Ctrl+click (Cmd+click
  on macOS) opens the link.
- Typing at either edge of a link goes outside it, so typing after `[[note]]`
  does not change which note it points to.
- Ctrl+K, or the "Edit link" command, opens a small popup to change the text
  and the target. With a selection and no link under the cursor, the popup
  creates a link: a web address makes `[text](url)`, a note name makes
  `[[note|text]]`. Leaving the target empty removes the link and keeps the text.
- With Live Read off, Ctrl+K does what Obsidian normally does. It is wrapped
  the same way as Ctrl+B (`editor:insert-link`).

Not covered yet: headings, lists, quotes, code blocks, math, callouts.
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
