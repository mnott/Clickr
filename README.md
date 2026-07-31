# clickr

An MCP server that lets any Claude Code session **see and operate this Mac directly** —
screenshot any display, click any coordinate, and type into any application.

It works at the level of the window server and the HID event tap, so it does not care
whether an app exposes AppleScript, an accessibility tree, or an API. If you can see it
and click it, clickr can drive it. This is deliberately general-purpose: the point is
instrumentation of *any* app, not a curated set of supported ones.

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

## Tools

| Tool | Purpose |
|---|---|
| `check_permissions` | Report Accessibility / Screen Recording status and how to fix them |
| `list_displays` | Every display's position and size in global points |
| `list_windows` | On-screen windows with app, title, and bounds |
| `list_apps` | Running applications with pid and bundle id |
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

1. `list_windows` (or `list_displays`) to find the target.
2. `screenshot` with `grid: true` to see and measure it.
3. `click` the field you want.
4. `type_text` with `app` set to the target application.

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

`type_text` sends one key event per character at a 20 ms interval, which measured 13/13
exact in testing. Smaller intervals occasionally drop characters, and batching several
characters into a single event corrupts text at the batch boundary — both were measured,
not assumed.

For anything long, use `method: "paste"`: it puts the text on the clipboard, presses
`cmd+V`, and restores the previous clipboard contents. It is far faster and immune to
per-character loss.

## Requirements and permissions

macOS with the Xcode Command Line Tools (for `swiftc`) and Node 18+.

Two permissions are needed, and they are granted to **the application that launches the
MCP server** — your terminal, or the Claude app — not to clickr itself:

- **Accessibility** — to post clicks and keystrokes.
- **Screen Recording** — to capture screenshots and read window titles.

Grant them in System Settings → Privacy & Security, then fully quit and reopen that
application. Run `check_permissions` to see current status. Activating an app may
additionally prompt once for **Automation** if the AppleScript fallback is reached.

## Install

```bash
npm install
npm run build      # compiles the Swift helper, then the TypeScript
```

Register it with Claude Code in `~/.claude.json` under `mcpServers`:

```json
"clickr": {
  "type": "stdio",
  "command": "node",
  "args": ["/absolute/path/to/clickr/dist/index.js"]
}
```

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
