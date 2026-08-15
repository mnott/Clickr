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

### Why coordinates are the risky part

A coordinate can go stale between being measured and being clicked, and the click then
lands on something else with nothing reporting an error. In one migration run this
produced about six silent mis-clicks from three different triggers — a page inserting a
toolbar and shifting every row down, a display changing resolution and moving every
window, and a window capture showing content that was really hidden behind another
window. All three look identical when they happen.

The worst near-miss: ticking a checkbox made a bulk-action toolbar appear, pushing rows
down ~64px, so queued clicks landed one row off and selected a *private* video — one
click from publishing it.

Clickr's guards against this are documented under
[Guarding against stale coordinates](#guarding-against-stale-coordinates); the
operating discipline that goes with them lives in the agent instructions rather than
here (see [How the agent is instructed](#how-the-agent-is-instructed)).

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

## Why it reads the screen as text

Screenshots are the expensive way to look at a screen, and the expense compounds. An
image costs roughly `width * height / 750` tokens **and stays in the conversation**, so
it is re-sent on every following turn — 30 full-display captures means ~54k tokens
carried by every subsequent request, and 120 means ~216k. A long automation run ends up
dominated by the screenshots it took near the *start*. An overnight run of ~51 web
uploads accumulated an estimated 180–270k tokens of resident images.

That cost had a safety consequence, which turned out to matter more: verifying a click
meant taking a screenshot, so verification got rationed — and the checks most likely to
be skipped were the ones that catch destructive mistakes. The private-video near-miss
above was caught only because a verification screenshot happened to exist.

So clickr reads the screen as text wherever it can:

- **`find_elements`** queries controls through the Accessibility API and returns exact
  click coordinates as text — ~60ms, roughly a tenth the cost of a capture, and exact
  rather than eyeballed. Works on native apps and on web pages.
- **`read_text`** runs macOS's on-device text recognition over a region and returns text
  only. No image, and no pixels leave the machine.
- **`click`** reports the element it hit, so confirming a click needs no capture.

Verification is now cheap enough to be unconditional, which is the real point: the safe
habit and the cheap habit are finally the same habit.

Screenshots remain available and are sometimes the right tool — a heavily custom web UI
may expose nothing useful to the accessibility tree. The default `maxDimension` is 800
(~590 tokens for a full display, against ~1800 at 1400), and re-capturing an unchanged
region returns a short text note instead of a duplicate image.

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
| `controls` | Record a control handover between operator and agent (see below) |

## Control handover

The actuating tools above (everything that clicks, types, drags, scrolls, or otherwise
touches the real machine) only run once the operator has handed control to the agent —
by saying **"your controls"** out loud, or by running `clickr controls you` in a
terminal. Saying **"my controls"** (or `clickr controls me`) takes it back. Read-only
tools — `screenshot`, `find_elements`, `read_text`, `list_windows`, and the rest —
always work, regardless of who holds control.

A grant lapses after 30 minutes of **inactivity** — every actuating call restarts that
clock, so a session in continuous use never lapses, while one left idle does and needs a
fresh handover. Hand over for longer by naming a window:

```
your controls for 6 hours
your controls for 90 minutes
```

The same phrasing works on the command line (`clickr controls you for 6 hours`, or
just `clickr controls you 6h`). The window is stored with the grant, so it survives
every refresh rather than collapsing back to the default on the agent's first click. It
is capped at 24 hours — the gate is an idle timer, not a permanent unlock.

**This is a clarity mechanism, not a security boundary**, and it is worth being
explicit about that rather than leaving it implied:

- **With `clickr install`'s `UserPromptSubmit` hook installed** (the default —
  `clickr install` registers it in `~/.claude.json`), the operator's spoken phrase is
  **authoritative**. The hook watches every prompt the operator submits, and the moment
  it sees "your controls" or "my controls" it updates the control state directly —
  before the agent even sees the message. Nothing the agent does or fails to do can get
  this wrong.
- **Without that hook installed**, nothing observes the conversation at all. The agent
  is trusted to notice the phrase and call the `controls` tool itself, in direct
  response to hearing it — which means an agent that chose to call `controls` on its
  own initiative, without a real handover, would not be stopped. Anyone with shell
  access can also just run `clickr controls you` directly, hook or not.

Treat the gate as a guardrail for normal, cooperative use — it stops an agent from
touching your mouse and keyboard by accident or overreach — not as a defense against an
adversarial agent or a local attacker.

```bash
clickr controls you             # hand control to the agent (30 min idle window)
clickr controls you for 6 hours # ... with a longer idle window (max 24h)
clickr controls me              # take it back
clickr controls status          # show who currently holds it
```

## Typical loop

1. `list_windows` or `list_displays` to find the target window.
2. `find_elements` to locate the control — exact click coordinates, as text.
3. `click`; the result reports which element was hit.
4. `type_text` with `app` set to the target application.

## Focus: the one sharp edge

Keyboard events go to whatever application is **frontmost**, which is not necessarily the
one that was last clicked. Two measured facts drive the design:

- A synthetic click **does not activate** the app it lands on. The click reaches the right
  window, but keyboard focus stays where it was. `click` therefore activates the window's
  owning app by default (`activate: false` opts out).
- `NSRunningApplication.activate()` is **silently ignored** for an unbundled command-line
  tool on current macOS. clickr tries that, then the Accessibility `AXFrontmost`
  attribute, then AppleScript, and **verifies** frontmost status after each — reporting
  which method actually worked.

Even then, other software can take focus back within milliseconds, so `type_text` and
`press_key` accept an `app` argument that activates the target and *refuses to type* if
it is not frontmost. Every response reports the `frontmostApp` that actually received
the input.

Worth knowing if you run this yourself: a focus-follows-mouse or autoraise utility will
fight synthetic activation, and **using the keyboard or mouse while clickr is driving**
causes dropped characters and misdirected clicks in both directions.

## Text entry

`type_text` has two modes, and the choice is not cosmetic.

**Paste** puts the text on the clipboard, presses `cmd+V`, and restores the previous
clipboard. It is the correct mode for any field with autocomplete or an IME, because such
fields re-enter and reorder characters between keystrokes: `https://github.com/new`
arrived as `thub.co/gim/new/` in Chrome's omnibox. A run of 51 uploads used paste for
every path, title and description with zero corruption, including paths containing `é`
and `à`.

**Keystroke** sends one key event per character at a 20 ms interval, which measured 13/13
exact. Smaller intervals occasionally drop characters, and batching several characters
into a single event corrupts text at the batch boundary — both measured, not assumed.

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

## How the agent is instructed

This README is for people. Nothing here needs to be read for clickr to be used correctly,
because **all agent-facing guidance ships inside the MCP server itself**:

| where | what | when it loads |
|---|---|---|
| `src/instructions.ts` | tool-choice ordering, the coordinate model, stale-coordinate hazards, verification habits, the native-dialog recipe | every session, automatically |
| each tool's description | detail for that specific tool — cost of a capture, when to use paste, what `expectGeometry` guards | on demand, when the tool is fetched |
| `skills/Clickr/SKILL.md` | installation and troubleshooting only | when the skill is triggered |

The split follows two constraints. Server instructions load in **every** session, so they
carry the rules whose absence causes damage and nothing else. Tool descriptions are
fetched on demand, so per-tool detail is cheaper there. And the skill exists only to solve
the bootstrap problem — before clickr is installed, its instructions do not exist yet, so
something has to explain how to install it.

Consequence worth stating: rules are **not** duplicated across these surfaces. If you
change how clickr should be used, change `src/instructions.ts` or the tool description —
not this file.

## License

MIT — see [LICENSE](LICENSE).

## Architecture

- `src/` — the MCP server (TypeScript, stdio transport).
- `native/clickr-helper.swift` — a long-lived helper process doing the real work: CGEvent
  posting, display and window enumeration, the Accessibility API, and image
  crop/scale/grid rendering. It speaks one JSON object per line over stdin/stdout.
- Screen capture shells out to `/usr/sbin/screencapture -R` with a global-point rectangle,
  which handles negative origins and regions spanning displays correctly.
