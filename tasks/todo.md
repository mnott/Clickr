## Continue

> **Last session:** 0008 - 2026-08-01 - Direct Link Following, Mcp Refactoring, And V0.3.0 Release
> **Paused at:** 2026-08-01T11:22:44.224Z
>
> Working directory: /Users/i052341/Daten/Cloud/Development/ai/clickr. Check the latest session note for details.

---
# Clickr — TODO

## Continue (state at 2026-08-01)

Shipped and published: `@tekmidian/clickr@0.3.0` on npm, https://github.com/mnott/Clickr.
MIT. Registered in `~/.claude.json`; skill installed to `~/.claude/skills/Clickr/`.

**Open:**

1. **Page reflow has no automatic guard.** The `geometry` token covers display changes
   only. A page inserting a toolbar does not change display geometry, so nothing but
   discipline (re-query, never batch across a state-changing click) catches it. Possibly
   unfixable from clickr's side — it is the argument for using the Chrome extension's
   `ref`s when the target is in a page.
2. **Custom web UIs may expose nothing to the accessibility tree.** LinkedIn's composer
   footer returned zero from `find_elements` and resolved only to the containing
   `AXWebArea`, forcing screenshot-and-measure. Worth checking whether a different AX
   traversal (e.g. not stopping at `AXWebArea`) would reach those controls.
3. The README's MIT line landed after the 0.3.0 publish, so the tarball copy is one line
   behind. Rides along with the next release; no action needed.

**Handed to PAI, awaiting their side:** a data-loss bug in PAI's `mcp.ts` —
`readClaudeJson()` returns `{}` on a parse error and `writeClaudeJson()` then overwrites,
so a malformed `~/.claude.json` would be replaced with a config containing only the `pai`
entry. Also asked PAI to check AIBroker for the same pattern. Clickr guards this by
throwing on unparseable config and backing up before every write.


## RESOLVED 2026-08-01 — root cause measured, fixes implemented

The compounding mechanism is **image accumulation in context**, not MCP call overhead.

Vision tokens ≈ `width * height / 750`. The old default (`maxDimension` 1400) produced
~1400x965 ≈ **1801 tokens** for a full display. The decisive part: **images persist in the
conversation and are re-sent on every subsequent turn**, so cost is cumulative, not per-shot:

| screenshots @1400 | tokens resident in EVERY later turn |
|---|---|
| 10 | 18k |
| 30 | 54k |
| 60 | 108k |
| 120 | 216k |

~51 uploads at 2-3 captures each ≈ 100-150 images ≈ **180-270k tokens carried per turn** by
the end of the run. That explains "1% per roundtrip", and why it grew through the night.

The caveat below still stands: a text-only turn also showed ~1%, so there is separate
per-turn overhead (hooks, SessionStart payloads, large MCP schemas). Both can be true.

**Shipped:**
1. Default `maxDimension` 1400 -> 800 (1801 -> 588 tokens, ~3x).
2. **Content-hash dedup** — re-capturing an unchanged region returns *text* instead of a
   second identical image. The first image is still in context, so re-sending is pure waste.
   Kills polling loops ("did it save yet?").
3. **`find_elements` / `element_at`** via the Accessibility API — query controls by
   role/title and get exact click coordinates as text. The structural fix (item 3 below).
4. `click` returns the AX element it hit (item 4 below).
5. `screenshot` description now states the token-cost rule (item 5 below).

**Item 6 was not a bug.** `screencapture -l` composites the window *unoccluded*, so it can
show content that is actually hidden behind another window. Coordinates are correct, but a
click there hits whatever is on top — exactly the "click missed, deselected a file" symptom.
Clickr now warns when a captured window is occluded.

Item 7 (display churn invalidating coordinates) is still open.

---

## Original analysis (raised 2026-08-01, from the YouTube migration session)

**Context:** drove ~51 YouTube uploads end-to-end via clickr (Studio UI + the native
macOS Open dialog). Worked correctly, but consumed a lot of tokens. Screenshots are
returned as images and billed as vision tokens at roughly `width * height / 750`:

| capture                | tokens |
|------------------------|--------|
| 1210x1250 (full list)  | ~2,000 |
| 1400x965 (full display)| ~1,800 |
| 900x250 (small strip)  | ~300   |

Caveat worth stating honestly: it is NOT yet proven that clickr was the dominant cost in
that session. A text-only turn also showed ~1% usage, which suggests significant per-turn
overhead elsewhere (hooks injecting context on every prompt, large MCP tool schemas,
SessionStart payloads). Matthias is investigating separately. Treat the items below as
"clickr can be cheaper regardless", not as a confirmed root cause.

### Ideas for clickr itself

1. **Default `maxDimension` lower than 1400.**
   The schema already says "Lower it to save tokens" — but the default (1400) is the
   expensive one, so callers pay maximum unless they know to opt out. Consider defaulting
   to ~800, or auto-scaling: if the requested region is only being used to read a label
   or confirm a radio state, full resolution is wasted.

2. **A text-only observation mode.**
   Biggest single win. Something like `describe_region` / `read_text(region)` returning
   OCR'd text or the AX tree as *text* instead of an image. Most of my screenshots existed
   only to answer "is this radio selected?" / "did the title save?" — questions with a
   one-line textual answer. `list_windows` already proves the pattern: geometry as text,
   ~100 tokens, no image.

3. **AX-based element query.**
   `find_element(app, role, title)` -> returns coordinates. Pixel-hunting forces a
   screenshot before *every* click; a selector-style lookup would remove most captures
   entirely. This is the structural fix — the others are mitigations.

4. **Return click verification in the click result.**
   `click` already returns `clickedWindow`. If it could also return the AX element hit
   (role/title/state), most post-click verification screenshots disappear.

5. **Docs / tool-description guidance.**
   Add an explicit "token cost" note to `screenshot`: state the ~w*h/750 rule and
   recommend `maxDimension` + tight regions. Agents optimise for what the schema tells them.

### Two real bugs I hit that cost extra round-trips

6. **`window:` capture returns wrong mapping metadata.**
   `screenshot(window: <id>)` returned an image of the *whole desktop* while reporting
   the region as the window's bounds. Coordinates computed from it were wrong and my
   click missed (deselected a file in an Open dialog). `display:` and explicit `region:`
   are exact. Either fix the capture or the reported mapping.

7. **Display/resolution churn silently invalidates coordinates.**
   During the run the display went 2560x1440 -> 1920x1080 -> 2420x1668 -> 1512x1042
   (external display off, then VNC from an iPad renegotiating). Windows migrated and every
   cached coordinate broke mid-sequence; one queued click landed on the wrong app.
   Would be useful: a `geometry_token` / generation counter that `click` can be checked
   against, so a stale coordinate fails loudly instead of clicking the wrong thing.

### Non-clickr gotcha worth documenting somewhere

8. macOS SMB mounts return filenames in **NFD**; CSV/JSON usually store **NFC**. Any
   filename comparison across `/Volumes/...` needs `unicodedata.normalize('NFC', ...)`
   on both sides, or every name containing é/à looks like a mismatch.
   (Also: `sha256sum *.mp4` breaks when a filename starts with `-` — use
   `find . -name '*.mp4' -print0 | xargs -0 sha256sum`.)
