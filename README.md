# clickr

An MCP server that lets any Claude Code session **see and operate this Mac directly** —
screenshot any display, click any coordinate, and type into any application.

It works at the level of the window server and the HID event tap, so it does not care
whether an app exposes AppleScript, an accessibility tree, or an API. If you can see it
and click it, clickr can drive it. This is deliberately general-purpose: the point is
instrumentation of *any* app, not a curated set of supported ones.

## Quick start

Tell Claude Code:

> Clone https://github.com/mnott/Clickr and set it up for me

Or install with a single command:

```bash
npm install -g @tekmidian/clickr && clickr install
```

Or manually, if you want the tests and a checkout:

```bash
git clone https://github.com/mnott/Clickr.git
cd Clickr
npm install          # also builds: the Swift helper and the TypeScript server
node dist/cli.js install
```

Any of these, then **restart Claude Code** — the tools do not appear until you do.

> Use `npm install -g`, not `npx`. The installer writes an absolute path to itself into
> `~/.claude.json`, and an `npx` cache directory is not a stable home for that — clearing
> the cache would silently break the registration. `clickr install` refuses to run from a
> cache directory for exactly that reason.

`install` does four things: builds the native Swift helper if missing, registers the MCP
server in `~/.claude.json` (backing that file up first), installs the Claude Code skill
to `~/.claude/skills/Clickr/`, and reports permission status.

| command | |
|---|---|
| `clickr install` | build, register, install the skill, check permissions |
| `clickr status` | what is registered and which permissions are granted |
| `clickr doctor` | diagnose a broken install — toolchain, helper, displays |
| `clickr uninstall` | remove the registration |

If you have this repo checked out already, `node dist/cli.js install` is the only step
you need; `npm install` runs the build via the `prepare` script.

### Requirements

macOS, Node 18+, and the Xcode Command Line Tools for `swiftc` (`xcode-select --install`).
`clickr doctor` tells you if any of that is missing.

### Permissions — the part that trips people up

Two are required, and **they are granted to the application that launches the MCP
server** — your terminal (iTerm2, Terminal) or the Claude app — **not to clickr itself**.
This is why granting them "to clickr" is impossible and why nothing appears under that
name in System Settings.

- **Accessibility** — to post clicks and keystrokes.
- **Screen Recording** — to capture screenshots and to read window titles.

Grant both in System Settings → Privacy & Security, then **fully quit and reopen** that
application; a reload is not enough. `clickr status` and the `check_permissions` tool both
report current state. Activating an app may additionally prompt once for **Automation**,
if the AppleScript fallback is reached.

### Registering by hand

If you would rather not run the installer, add this to `mcpServers` in `~/.claude.json`:

```json
"clickr": {
  "type": "stdio",
  "command": "node",
  "args": ["/absolute/path/to/Clickr/dist/index.js"]
}
```

## Use it as a fallback, not a default

Clickr can drive anything, which is exactly why it should not be your first choice.

**The deciding question is not cost — it is whether the user can keep working.** Clickr
moves the real pointer and types on the real keyboard, so for the duration the machine is
the agent's, not the user's. They cannot answer an email or click anything without
corrupting the automation, and vice versa: concurrent human input measurably produces
dropped characters and clicks landing on the wrong element. Everything above clickr in
this list leaves the user's hands free.

| | tool | what it takes from the user |
|---|---|---|
| 1 | **API / CLI / file edits** — `gh`, HTTP, writing a file | Nothing. Headless. |
| 2 | **[macos-automator-mcp](https://github.com/steipete/macos-automator-mcp)** using an app's **AppleScript/JXA dictionary** | Nothing. The app does the work internally and the pointer never moves. Also immune to windows moving, since it addresses things by name — "the third message of the front mailbox" — rather than by coordinate. Finder, Mail, Safari, Terminal, DEVONthink and most established Mac apps qualify. |
| 3 | **[Claude in Chrome](https://claude.com/chrome)** | A browser tab. Pointer, keyboard and every other app stay with the user. Also cheaper and more correct than clickr: text rather than images, and `ref`s that survive reflow. |
| 4 | **Clickr**, and **AppleScript UI scripting** (`System Events` keystroke/click) | The whole machine. The user must stop working. |

AppleScript spans tiers 2 and 4, and the difference matters: a *dictionary* script costs
the user nothing, while *UI scripting* through System Events synthesises exactly the
events clickr does and is just as exclusive. "It's AppleScript" does not mean
"non-invasive".

### The exception: when being watched is the point

If the user wants to *see* it — "show me how to do a pivot table in Excel", "walk me
through this dialog" — go straight to clickr. The visible interaction is the deliverable,
and doing it headlessly with a script produces the right end state while missing what was
actually asked for.

### And when you do take over

Say so first, with a rough duration, and say when you are done. The user cannot know to
keep their hands off unless they are told.

### What clickr is genuinely needed for

Measured across a session that drove ~51 YouTube uploads end to end:

- **The native macOS Open/Save dialog.** A browser extension cannot cross out of the page
  into a native window, and the dialog is not meaningfully scriptable either — it belongs
  to the app that raised it and exposes no useful AppleScript surface. This is the main
  reason clickr exists.
- **Apps with no scripting dictionary** — Electron apps, games, remote-desktop sessions,
  and anything drawing its own UI in a canvas.

Everything else in that run was better served by the Chrome extension. If an app *is*
scriptable, use macos-automator-mcp instead: a script that says "click the button named
Export" cannot be broken by a window moving, and a coordinate can.

The whole native-dialog flow is capture-free — every control is queryable by role and
title, verified against TextEdit's Open dialog:

```
AXButton "Open"    @(1645,744)     AXButton "Cancel"  @(1563,744)
AXPopUpButton "Where:"             AXTextField focused=true  (the Cmd+Shift+G path field)
```

So: trigger the picker in the page, `press_key g cmd+shift`, paste the absolute path,
`press_key return`, then `find_elements` for the "Open" button and click it. About three
actions per upload, no screenshots.

### Stale coordinates: the correctness argument, stronger than the cost one

A coordinate can go stale between deciding and clicking, and the click then lands on
something else silently. Real incident: ticking YouTube's first checkbox made a
bulk-action toolbar appear, pushing every row down ~64px. Queued clicks landed one row
off and selected a *private* video, one click from publishing it. An element `ref` would
have been immune.

That run produced roughly six silent mis-clicks from **three distinct triggers**. They
need different fixes, and — importantly — they are indistinguishable from each other *at
the time*. All three present identically: the click lands somewhere plausible but wrong,
and nothing errors. They were only separated afterwards, by reconstructing what had
changed between calls.

| trigger | cause | fix |
|---|---|---|
| **Layout reflow** | **Self-inflicted and deterministic.** Your own click 1 inserts a toolbar, which breaks clicks 2..n of the same batch. | **Never batch coordinate clicks across a state-changing action.** Not "re-query often" — this one is fully avoidable. |
| **Display geometry change** | **External and unpredictable.** A monitor sleeps, a VNC client reconnects at a different resolution; every window moves. Can strike at any moment. | Carry the `geometry` token from `list_displays`/`find_elements` into `click` as `expectGeometry`; a mismatch refuses the action. |
| **Occlusion** | A window capture composites the target unobstructed, so a coordinate read off it hits whatever is really on top. | `screenshot` warns, with covered-% and the covering app. |

The first two are worth keeping apart rather than collapsing into "things move sometimes":
one is bad luck you can only detect, the other is a mistake you can simply not make.

The general rule: **treat a coordinate as valid only for the state you measured it in.**

### Verification is now cheap enough to be unconditional

This is the habit change that matters. Verifying a state-changing click used to mean a
screenshot at ~2000 tokens, so verification got rationed — and the checks most likely to
be skipped were exactly the ones that catch destructive mistakes. The private-video
near-miss above was caught only because a verification screenshot happened to exist.

`click` now returns `hitElement`, and `find_elements` costs ~385 tokens. So:

> **Verify every state-changing click. The safe habit and the cheap habit are now the
> same habit.**

The old instinct — batch the clicks and hope — was a rational response to expensive
verification. It no longer is.

## What it gives you

- **Measure** — screenshot a display, a region, or a single window, with an optional
  labelled coordinate grid drawn straight onto the image.
- **Click** — post real mouse events at any global coordinate, on top of whatever window
  happens to be there.
- **Type** — send real Unicode key events into whatever holds keyboard focus, plus
  shortcuts, scrolling, and dragging.

## The coordinate model (the important part)

Everything — screenshots, window bounds, clicks, drags — uses **one global point space**:

- Origin is the **top-left of the main display**, with **+y pointing down**.
- Displays arranged to the left of or above the main one have **negative** coordinates.
- Units are **points**, not device pixels. A Retina display reports 2560×1440 points even
  though it captures 5120×2880 pixels.

Any number of displays works, in any arrangement; they simply extend this one space.
Because it is a single space, a coordinate read off a screenshot can be passed to `click`
unchanged. There is no per-display mode to select and no pixel/point conversion to get
wrong.

A verified example from a two-display setup, where the second display sits to the *left*:

```
display 1 (main): x=0     y=0  2560x1440   (5120x2880 native, scale 2)
display 2:        x=-2560 y=0  2560x1440   (5120x2880 native, scale 2)
combined desktop: x=-2560 y=0  5120x1440
```

### Measuring precisely

`screenshot` always reports the exact arithmetic to convert an image pixel back to a
global coordinate. Two rules make this easy:

- A region of **1400 points or less** comes back at **1:1** — one image pixel is exactly
  one point, so no conversion is needed at all.
- Anything larger is scaled down uniformly, and the response states the factor.

For fiddly targets, screenshot a small region around the element rather than the whole
screen. Passing `grid: true` overlays labelled global coordinates directly on the image,
so a click target can be read off by eye.

## Cost: prefer text over pixels

This matters more than anything else in this README. An image costs roughly
`width * height / 750` tokens **and stays in the conversation**, so it is re-sent on
every following turn. Cost is cumulative, not per-screenshot:

| full-display screenshots | tokens carried by every later turn |
|---|---|
| 10 | 18k |
| 30 | 54k |
| 60 | 108k |
| 120 | 216k |

A long automation run is therefore dominated by screenshots taken near the *start*.
An overnight run of ~51 web uploads at 2–3 captures each accumulated an estimated
180–270k tokens of resident images.

clickr offers three ways to avoid that, in order of preference:

1. **`find_elements`** — query controls through the Accessibility API by role and
   title, and get exact click coordinates back as text. ~60ms, a few hundred tokens,
   and exact rather than eyeballed. Works for native apps *and* for web pages, since
   Chrome and Safari expose the DOM as accessibility elements. This removes the need
   for most captures entirely.
2. **`read_text`** — macOS's on-device text recognition reads a region and returns
   **text only, no image**. Use it for "what does the error say", "did it save", or
   anything on a canvas/video/remote desktop that the accessibility tree cannot see.
   Plain text is by far the cheapest form; `withCoordinates` adds a click point per
   line but costs several times more, so keep the region tight when using it.
3. **`click` already reports what it hit** (`hitElement`), so confirming a click
   usually needs no capture at all.

When you do capture: the default `maxDimension` is 800 (~590 tokens for a full
display, versus ~1800 at 1400), a tight region beats a whole display, and
**re-capturing an unchanged region returns a short text note instead of an identical
image** — the earlier one is still in context, so re-sending it is pure waste.

## Tools

| Tool | Purpose |
|---|---|
| `check_permissions` | Report Accessibility / Screen Recording status and how to fix them |
| `list_displays` | Every display's position and size in global points |
| `list_windows` | On-screen windows with app, title, and bounds |
| `list_apps` | Running applications with pid and bundle id |
| `find_elements` | **Locate controls as text with exact click coordinates — prefer over screenshot** |
| `read_text` | **On-device OCR of a region; returns text, no image** |
| `element_at` | Describe the accessibility element at a coordinate |
| `screenshot` | Capture a display, region, window, app, or the whole desktop |
| `click` | Click at a global coordinate, with modifiers and multi-click |
| `move_mouse` | Move the pointer (hover states) |
| `drag` | Press, drag along an interpolated path, release |
| `scroll` | Scroll the wheel, optionally after moving the pointer |
| `type_text` | Type Unicode text, by keystroke or via paste |
| `press_key` | Named keys and shortcuts (`cmd+S`, arrows, function keys) |
| `get_mouse_position` | Current pointer position |
| `activate_app` | Bring an app to the front, verified |
| `set_window_bounds` | Move / resize / raise a specific window |
| `get_clipboard` / `set_clipboard` | Read and write the clipboard |

## Typical loop

1. `list_windows` (or `list_displays`) to find the target window.
2. `find_elements` with a `role` and/or `titleContains` to locate the control — this
   returns exact click coordinates as text.
3. `click` those coordinates; the result tells you which element was hit.
4. `type_text` with `app` set to the target application.

Reach for `screenshot` when you genuinely need to *see* layout — an unfamiliar UI, a
visual state that has no textual equivalent — rather than as the default first step.
When you do, `grid: true` overlays labelled global coordinates so a target can be read
straight off the image.

## Focus: the one sharp edge

Keyboard events go to whatever application is **frontmost**, which is not necessarily the
one you last clicked. Two measured facts drive the design here:

- A synthetic click **does not activate** the app it lands on. The click reaches the right
  window, but keyboard focus stays where it was. `click` therefore activates the window's
  owning app by default (`activate: false` opts out).
- `NSRunningApplication.activate()` is **silently ignored** for an unbundled command-line
  tool on current macOS. clickr tries that, then the Accessibility `AXFrontmost`
  attribute, then AppleScript, and **verifies** frontmost status after each — reporting
  which method actually worked.

Even so, other software can take focus back within milliseconds. So:

> **Pass `app` to `type_text` and `press_key`.** It activates the target first and then
> *refuses to type* if that app is not frontmost, turning "typed into the wrong window"
> from a silent accident into a harmless error. Every response also reports the
> `frontmostApp` that actually received the input.

Two things worth knowing about this machine specifically: a focus-follows-mouse /
autoraise utility will fight synthetic activation, and **using the keyboard or mouse while
clickr is driving** causes dropped characters and misdirected clicks. Keep hands off
during an automated sequence.

## Text entry

**Any field with autocomplete or an IME gets `method: "paste"`, never keystrokes.**
This is a rule, not a tip. An autocompleting field re-enters and reorders characters
between keystrokes, so typed text arrives scrambled: `https://github.com/new` became
`thub.co/gim/new/` in Chrome's omnibox. The same applies to the Open dialog's
Cmd+Shift+G path field, search boxes, and address fields. A run of 51 uploads used paste
for every path, title and description and had zero corruption — including paths
containing `é` and `à`, which per-character typing also puts at risk.

Paste puts the text on the clipboard, presses `cmd+V`, and restores the previous
clipboard contents. It is also far faster for long text.

Keystroke mode sends one key event per character at a 20 ms interval, which measured
13/13 exact. Smaller intervals occasionally drop characters, and batching several
characters into a single event corrupts text at the batch boundary — both measured, not
assumed. Use it for plain fields where you want realistic per-character input.

## Guarding against stale coordinates

`list_displays` and `find_elements` both return a `geometry` token fingerprinting the
current display layout. Pass it to `click`, `drag`, `scroll` or `move_mouse` as
`expectGeometry`, and if the layout changed in between the action is **refused** instead
of landing on whatever moved underneath:

```
refusing to act: the display layout changed since these coordinates were measured
(expected geometry abc123, now 1akrqqsmw2kd6). Windows have moved, so this coordinate
probably points at something else. Re-read list_displays and re-locate the target.
```

This covers the display-geometry trigger only. Layout reflow inside a page does not
change display geometry, so nothing but re-querying protects against that one.

## Tests

```bash
node scripts/smoke-test.mjs          # MCP protocol, displays, capture, error paths
node scripts/functional-test.mjs     # drives real Chrome end to end
node scripts/typing-reliability.mjs 8 "20,30"   # typing fidelity by delay
```

The functional test opens a page in Chrome that reports back the coordinates and text it
actually received, so click accuracy is verified numerically (it lands within 0 px) rather
than merely assumed. It closes its own tab afterwards and leaves your window where it was;
window move/resize checks are opt-in via `MOVE_WINDOW=1` precisely because shoving your
window around mid-session is obnoxious.

## Architecture

- `src/` — the MCP server (TypeScript, stdio transport).
- `native/clickr-helper.swift` — a long-lived helper process doing the real work: CGEvent
  posting, display and window enumeration, the Accessibility API, and image
  crop/scale/grid rendering. It speaks one JSON object per line over stdin/stdout.
- Screen capture shells out to `/usr/sbin/screencapture -R` with a global-point rectangle,
  which handles negative origins and regions spanning displays correctly.
