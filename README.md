# Live Read

An Obsidian plugin that works on top of Live Preview. When it is on, inline
markdown markers (bold, italic, strike, highlight, inline code) stay hidden even
when the cursor is on them, so you edit the rendered text directly.

Desktop only for now.

## Use

- Command: "Live Read: Toggle Live Read". Suggested hotkey: Ctrl+Alt+L
  (Cmd+Alt+L on macOS). You can change it in Settings > Hotkeys.
- Or click "Live Read: on/off" in the status bar.

The on/off state is global and is saved in the plugin settings.
It only has an effect in Live Preview, not in Source mode or Reading view.

## Build

```
npm install
npm run build   # type check + bundle to main.js
npm run dev     # rebuild on every change
```

`main.js` is a build output and is not tracked in Git. After checking out an
older commit, run `npm run build` again so Obsidian loads that version.
