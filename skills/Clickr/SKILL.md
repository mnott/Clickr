---
name: Clickr
description: Drive any macOS application by screen coordinate — screenshot, click, type. USE WHEN a task needs a native macOS dialog (especially the Open/Save file dialog), a non-browser app, or anything no other tool can reach. Also USE WHEN installing clickr, or when asked to make screen automation cheaper.
---

# Clickr — macOS screen and input control

Clickr posts real mouse and keyboard events and reads the screen, so it can drive any
application without that application exposing an API. That power is also why it should
not be your first choice.

## Installing clickr

When asked to install clickr — "clone github.com/mnott/Clickr and set it up for me" or
similar — the shortest reliable path is:

```bash
npm install -g @tekmidian/clickr && clickr install
```

Or from source, if the user wants a checkout they can run the tests from. Clone into a
directory they are happy to keep, not a temporary one — the registration points at it:

```bash
git clone https://github.com/mnott/Clickr.git
cd Clickr
npm install          # the prepare script builds the Swift helper and the TS server
node dist/cli.js install
```

Do **not** use `npx`: the installer writes an absolute path to itself into
`~/.claude.json`, and it refuses to run from an npx cache because clearing that cache
would break the registration silently.

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

## Choosing how to drive the computer

Ask one question first, because it overrides the whole ordering below:

### Is the visible interaction itself the deliverable?

If the user wants to *watch* — "show me how to do a pivot table in Excel", "walk me
through this dialog", "demonstrate the export settings" — then **go straight to clickr**.
The point is that they see it happen on their screen. Doing it headlessly with a script
produces the right end state and completely misses what was asked for.

Otherwise, the goal is the end state, and you should take as little of the user's machine
as possible to get there.

### Otherwise: use the least invasive tool that can do the job

The ordering is not mainly about tokens. It is about **whether the user can keep working
while you do it**. Clickr moves the real pointer and types on the real keyboard, so the
machine is *yours* for the duration — the user cannot type an email or click anything
without corrupting what you are doing, and vice versa. That is a genuine cost to them,
and it is the main reason clickr goes last.

| | tool | what it takes from the user |
|---|---|---|
| 1 | **API / CLI / file edits** — `gh`, HTTP, writing a file | Nothing. Headless. Always prefer this. |
| 2 | **macos-automator-mcp** (`mcp__macos_automator__execute_script`) using an app's **AppleScript/JXA dictionary** | Nothing. The app does the work internally; the pointer never moves. Also immune to windows moving, since it addresses things by name. |
| 3 | **The Chrome extension** (`mcp__claude-in-chrome__*`) | A browser tab. The user keeps the pointer, keyboard, and every other app. Also cheaper and more correct than clickr — text not images, and `ref`s survive reflow. |
| 4 | **Clickr**, and **AppleScript UI scripting** (`System Events` keystroke/click) | The whole machine. Pointer and keyboard are seized; the user must stop working. |

Note that AppleScript is split across tiers 2 and 4. A *dictionary* script (`tell
application "Finder" to duplicate file x`) is tier 2 and costs the user nothing. *UI
scripting* through System Events synthesises the same events clickr does and belongs in
tier 4 — do not treat "it's AppleScript" as automatically non-invasive.
`get_scripting_tips` will tell you whether an app has a real dictionary.

### When you do take over the machine

Say so before you start, and give a rough duration: *"This will drive your screen for
about a minute — please don't use the mouse or keyboard until I say it's done."* Then say
when you are finished.

This is not politeness. Concurrent human input corrupts automation in both directions:
measured, it produces dropped characters and clicks landing on the wrong element. The
user cannot know to keep their hands off unless you tell them.

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

### Take the direct link when the app offers one

After creating something, apps usually offer a way straight to it — "View post", "Show in
Finder", "Open file", "Go to record". **Follow it instead of dismissing the dialog and
hunting for the object in a list.**

This is not a shortcut, it is error elimination. Navigating directly means you are
operating on the thing you just created, by construction. Finding it in a list means
identifying the right row among near-identical ones — and picking the wrong row is the
single most damaging mistake available in UI automation.

Real example: after publishing a post, the success dialog offered "View post". Dismissing
it meant returning to a feed with two identical "Comment" buttons, and needing a
screenshot to confirm which post was the right one before commenting. Following the link
would have led straight to the correct comment box with nothing to disambiguate.

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
