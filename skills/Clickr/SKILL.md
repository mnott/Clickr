---
name: Clickr
description: Drive any macOS application by screen coordinate — screenshot, click, type. USE WHEN a task needs a native macOS dialog (especially the Open/Save file dialog), a non-browser app, or anything no other tool can reach. Also USE WHEN installing clickr, or when asked to make screen automation cheaper.
---

# Clickr — macOS screen and input control

Clickr posts real mouse and keyboard events and reads the screen, so it can drive any
application without that application exposing an API. That power is also why it should
not be your first choice.

## Installing clickr

When asked to install clickr — "download github.com/mnott/clickr and install it" or
similar — run this, from any directory the user is happy to keep a checkout in:

```bash
git clone https://github.com/mnott/Clickr.git
cd Clickr
npm install          # the prepare script builds the Swift helper and the TS server
node dist/cli.js install
```

`install` builds the native helper if missing, registers the MCP server in
`~/.claude.json` (backing that file up to `~/.claude.json.bak-clickr` first), installs
this skill to `~/.claude/skills/Clickr/`, and prints permission status. It is idempotent —
running it again just updates the registration.

Then **tell the user to restart Claude Code**; the tools do not appear until they do.
You cannot pick them up in your own session either.

Other commands: `node dist/cli.js status` (what is registered, which permissions),
`doctor` (toolchain, helper, displays), `uninstall` (deregister).

**Requirements:** macOS, Node 18+, Xcode Command Line Tools for `swiftc`
(`xcode-select --install`). `doctor` reports what is missing.

**Permissions — explain this, it confuses people.** Clickr needs **Accessibility** (to
click and type) and **Screen Recording** (to capture and read window titles). Both are
granted to *the app that launches the MCP server* — the user's terminal, or the Claude
app — **not to clickr**, which is why nothing called "clickr" appears in System Settings.
They must grant them in System Settings → Privacy & Security and then **fully quit and
reopen** that application. If a later `activate_app` prompts for **Automation**, that is
the AppleScript activation fallback and is expected.

## Choose the right tool first

Clickr is the fallback, not the default. In order:

1. **A real API or CLI.** If the job can be done with `gh`, an HTTP call, or a file write,
   do that. No UI automation is more reliable than not needing it.
2. **The Chrome extension** (`mcp__claude-in-chrome__*`) for anything inside a web page.
   It is cheaper *and more correct* than clickr: it reads pages as text, and it addresses
   elements by `ref`, which stays bound to the element even when the page reflows.
3. **macos-automator-mcp** (`mcp__macos_automator__execute_script`) for any app with an
   AppleScript or JXA dictionary — Finder, Mail, Safari, Terminal, DEVONthink and most
   established Mac apps. It drives apps through their own scripting interface, addressing
   things by name rather than coordinate, so nothing it does can go stale when a window
   moves. Strictly more reliable than clickr wherever it applies. Its
   `get_scripting_tips` tool will tell you whether a given app is covered.
4. **Clickr**, for what none of the above can touch.

### What clickr is actually needed for

Measured, not assumed — from a session that drove ~51 YouTube uploads:

- **The native macOS Open/Save dialog.** The browser extension cannot cross out of the
  page into a native window, and the dialog exposes no useful AppleScript surface either.
  This is the main reason clickr exists.
- **Apps with no scripting dictionary** — Electron apps, games, remote-desktop sessions,
  anything drawing its own UI in a canvas.

Everything else in that run was better done by the Chrome extension. If the app *is*
scriptable, prefer macos-automator-mcp: "click the button named Export" cannot be broken
by a window moving; a coordinate can.

### The correctness argument for using refs where you can

A queued coordinate can go stale between deciding and clicking. Real incident: ticking
YouTube's first checkbox made a bulk-action toolbar appear, which pushed every row down
~64px. Queued clicks landed one row off and selected a *private* family video, one click
away from publishing it. A `ref` in the extension would have been immune.

**Rule: treat a coordinate as valid only for the state you measured it in.** That run
produced ~6 silent mis-clicks from three triggers. All three look identical when they
happen — the click lands somewhere plausible and nothing errors — so you cannot diagnose
them in the moment, only prevent them:

- **Layout reflow** — *self-inflicted and deterministic*. Your own click 1 inserts a
  toolbar, which breaks clicks 2..n of the same batch. The rule is not "re-query often",
  it is **never batch coordinate clicks across a state-changing action**. Fully avoidable.
- **Display geometry change** — *external and unpredictable*. A display sleeping or a VNC
  client reconnecting moves every window, at any moment. Carry the `geometry` token from
  `list_displays`/`find_elements` into `click` as `expectGeometry`; a mismatch refuses the
  action instead of clicking whatever moved underneath.
- **Occlusion** — a window capture composites the target unobstructed, so a coordinate
  read off it can hit whatever is really on top. `screenshot` warns about this.

## Verify every state-changing click

`click` returns `hitElement` — the role, title and state of what it actually hit — and
`find_elements` costs ~385 tokens. Verification used to mean a ~2000-token screenshot, so
it got rationed, and the skipped checks were exactly the ones that catch destructive
mistakes. A near-miss on publishing a private video was caught only because a
verification screenshot happened to exist.

**The safe habit and the cheap habit are now the same habit.** Check `hitElement` after
any click that changes state, selects, deletes, or publishes. The instinct to batch and
hope was a rational response to expensive verification; it no longer is.

## Use text, not pixels

A screenshot costs roughly `width * height / 750` tokens **and stays in the conversation,
so it is re-sent on every later turn**. Thirty full-screen captures means ~54k tokens
carried by every subsequent request; a long run is dominated by images taken near its
start. Prefer, in order:

1. **`find_elements`** — query controls by `role` and/or `titleContains`, get exact
   click coordinates back as text. ~60ms, roughly a tenth the cost of a capture, and
   exact rather than eyeballed. Works on native apps *and* web pages.
2. **`read_text`** — on-device OCR of a region, text only, no image. For canvas, video,
   remote desktop, or anything the accessibility tree cannot see.
3. **`click` already reports the element it hit** (`hitElement`), so verifying a click
   usually needs no capture at all.

Only screenshot when you genuinely need to *see* layout you cannot query. Then keep the
region tight, keep `maxDimension` small, and prefer a 1:1 region over a whole display.
Re-capturing an unchanged region returns text instead of a duplicate image.

## Recipe: upload a file through a native Open dialog

Fully capture-free. Every element below is queryable by role and title.

1. Trigger the file picker in the page (Chrome extension, by `ref`).
2. `press_key` `g` with `["cmd","shift"]` — opens "Go to folder".
3. `type_text` the **absolute path**, `method: "paste"`, then `press_key` `return`.
   Paste rather than keystrokes: path fields autocomplete and reorder typed characters.
4. `find_elements` with `role: "AXButton"`, `titleContains: "Open"` → `click` its
   `centerX`/`centerY`.
5. Control returns to the page; go back to the Chrome extension.

If you must confirm the dialog state, `find_elements` with `role: "AXTextField"` — the
Go-to-folder field is the one with `focused: true`.

## Coordinates

One global point space: origin at the **top-left of the main display**, **+y down**,
in **points** (not device pixels). Displays left of or above the main one have
**negative** coordinates, and any number of displays is supported. Everything —
`find_elements`, `list_windows`, `screenshot`, `click` — speaks this same space, so a
coordinate from one goes straight into another.

## Typing goes to whatever is frontmost

A synthetic click does *not* activate the app it lands on. Always pass `app` to
`type_text` and `press_key`: it activates the target first and **refuses to type** if
that app is not frontmost, which turns "typed into the wrong window" into a harmless
error.

**Any field with autocomplete or an IME gets `method: "paste"`, never keystrokes.**
Autocompleting fields re-enter and reorder characters between keystrokes:
`https://github.com/new` arrived as `thub.co/gim/new/` in Chrome's omnibox. Applies to
URL bars, search boxes, and the Open dialog's Cmd+Shift+G path field. Paste is also the
safe path for text containing accented or non-Latin characters.

**Do not use the keyboard or mouse while clickr is driving** — concurrent input causes
dropped characters and misdirected clicks.

## Troubleshooting

- **Tools missing after install** — Claude Code was not restarted.
- **Clicks or typing do nothing** — Accessibility not granted, or the granting app was
  reloaded rather than fully quit and reopened. Check with `check_permissions`.
- **Screenshots fail, or window titles come back empty** — Screen Recording not granted.
- **Text arrives scrambled** — an autocompleting field; use `method: "paste"`.
- **Typing goes to the wrong app** — pass `app` to `type_text`/`press_key`.
- **A click lands on the wrong thing** — the coordinate went stale. See the three
  triggers above; re-query with `find_elements` rather than reusing coordinates.
- **`swiftc` not found** — `xcode-select --install`.
