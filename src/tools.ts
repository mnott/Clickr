import {
  capture,
  coordinateGuide,
  unionOfDisplays,
  type Rect,
} from "./capture.js";
import { getDisplays, getWindows, helper } from "./helper.js";

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, any>) => Promise<Content[]>;
}

const text = (s: string): Content[] => [{ type: "text", text: s }];
const json = (o: unknown): Content[] => [
  { type: "text", text: JSON.stringify(o, null, 2) },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Activates `app` and returns the guard to attach to input commands.
 *
 * Keyboard events always go to the frontmost application, and clicking a window
 * does not reliably make its app frontmost — other software (window managers,
 * focus-follows-mouse utilities, a busy terminal) can take focus back within
 * milliseconds. Activating immediately before typing and then asserting the
 * destination turns "typed into the wrong app" from a silent accident into a
 * loud, harmless error.
 */
async function focusTarget(app?: string): Promise<{ expectApp?: string }> {
  if (!app) return {};
  await helper.send("activate", { name: app });
  await sleep(250);
  return { expectApp: app };
}

const num = { type: "number" } as const;
const str = { type: "string" } as const;
const bool = { type: "boolean" } as const;
const modifiers = {
  type: "array",
  items: { type: "string", enum: ["cmd", "shift", "alt", "ctrl", "fn"] },
  description: "Modifier keys held for the duration of the action.",
} as const;

/** Every tool that moves the pointer or types shares this coordinate contract. */
const COORD_NOTE =
  "Coordinates are global points: the origin is the top-left of the main display, " +
  "+y points down, and displays to the left of or above the main one have negative " +
  "coordinates. This is the same space the screenshot tool reports, so a value read " +
  "off a screenshot can be used here directly.";

export const tools: Tool[] = [
  {
    name: "check_permissions",
    description:
      "Reports whether macOS has granted the two permissions clickr needs: Accessibility " +
      "(to post clicks and keystrokes) and Screen Recording (to capture screenshots and " +
      "read window titles). Call this first if anything fails unexpectedly.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          ...bool,
          description:
            "Ask macOS to show the Accessibility permission dialog if it is not granted.",
        },
      },
    },
    handler: async (a) => {
      const res = await helper.send("permissions", { prompt: !!a.prompt });
      const lines = [
        `Accessibility (click + type): ${res.accessibility ? "GRANTED" : "DENIED"}`,
        `Screen Recording (screenshots): ${res.screenRecording ? "GRANTED" : "DENIED"}`,
      ];
      if (!res.accessibility || !res.screenRecording) {
        lines.push(
          "",
          "Both permissions are granted to the application that launched this MCP server",
          "(your terminal, e.g. iTerm2 or Terminal, or the Claude app) — not to clickr itself.",
          "Grant them in System Settings > Privacy & Security > Accessibility and",
          "> Screen Recording, then fully quit and reopen that application."
        );
      }
      return text(lines.join("\n"));
    },
  },

  {
    name: "list_displays",
    description:
      "Lists every attached display with its position and size in global points. " +
      "Handles any number of displays in any arrangement, including ones positioned " +
      "left of or above the main display (negative coordinates). Call this before " +
      "screenshotting to learn which display index you want.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const displays = await getDisplays();
      const union = unionOfDisplays(displays);
      const rows = displays.map((d) => ({
        index: d.index,
        main: d.main,
        bounds: { x: d.x, y: d.y, width: d.width, height: d.height },
        nativePixels: `${d.pixelWidth}x${d.pixelHeight}`,
        backingScale: d.scale,
      }));
      return json({
        displayCount: displays.length,
        displays: rows,
        combinedDesktopBounds: union,
        note: "bounds are in global points — pass them straight to screenshot or click.",
      });
    },
  },

  {
    name: "list_windows",
    description:
      "Lists on-screen windows with their app, title and bounds in global points. " +
      "Use it to find a target window's coordinates, or to identify what is under a point.",
    inputSchema: {
      type: "object",
      properties: {
        app: {
          ...str,
          description: "Only windows whose app name or title contains this (case-insensitive).",
        },
        includeAllLayers: {
          ...bool,
          description:
            "Include menus, panels and overlays (layer != 0), not just normal windows.",
        },
        onScreenOnly: {
          ...bool,
          description: "Only currently visible windows. Default true.",
        },
      },
    },
    handler: async (a) => {
      const windows = await getWindows({
        app: a.app,
        onScreenOnly: a.onScreenOnly ?? true,
        includeAllLayers: !!a.includeAllLayers,
      });
      return json({ windowCount: windows.length, windows });
    },
  },

  {
    name: "list_apps",
    description:
      "Lists running applications that can own windows, with pid and bundle id. " +
      "Use the pid or name with activate_app or set_window_bounds.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const res = await helper.send("apps");
      return json({ appCount: (res.apps as unknown[]).length, apps: res.apps });
    },
  },

  {
    name: "screenshot",
    description:
      "Captures a screenshot and returns it as an image, together with the exact arithmetic " +
      "for converting any pixel in that image into a global coordinate you can click. " +
      "Choose exactly one target: display, region, window, app, or all. " +
      "Regions of 1400 points or less come back at 1:1 (one image pixel = one point), which " +
      "is the reliable way to measure a small UI element precisely. " +
      "Turn on `grid` to overlay labelled global coordinates directly onto the image.",
    inputSchema: {
      type: "object",
      properties: {
        display: {
          ...num,
          description: "1-based display index from list_displays. Captures that whole screen.",
        },
        region: {
          type: "object",
          description:
            "A rectangle in global points. May span displays and may use negative coordinates.",
          properties: { x: num, y: num, width: num, height: num },
          required: ["x", "y", "width", "height"],
        },
        window: {
          ...num,
          description:
            "windowId from list_windows. Captures just that window even if partly covered.",
        },
        app: {
          ...str,
          description:
            "App name — captures that app's frontmost on-screen window. Convenient shorthand for window.",
        },
        all: {
          ...bool,
          description: "Capture every display at once, as one combined image.",
        },
        grid: {
          ...bool,
          description:
            "Overlay a labelled coordinate grid. Labels are global points, so you can read a " +
            "click target straight off the image. Highly recommended when measuring.",
        },
        gridStep: { ...num, description: "Grid spacing in points. Default: chosen automatically." },
        maxDimension: {
          ...num,
          description:
            "Longest edge of the returned image in pixels. Default 1400. Lower it to save tokens.",
        },
        fullResolution: {
          ...bool,
          description:
            "Capture at native device pixels (2x on Retina) instead of points. Use for very fine " +
            "measurement of a small region.",
        },
        delay: {
          ...num,
          description: "Wait this many milliseconds before capturing, to let the UI settle.",
        },
        savePath: { ...str, description: "Also write the PNG to this absolute path." },
      },
    },
    handler: async (a) => {
      const chosen = ["display", "region", "window", "app", "all"].filter(
        (k) => a[k] !== undefined && a[k] !== null && a[k] !== false
      );
      if (chosen.length > 1) {
        throw new Error(
          `Choose exactly one capture target; got ${chosen.join(" and ")}.`
        );
      }

      if (a.delay) await sleep(Math.min(10_000, Math.max(0, a.delay)));

      const displays = await getDisplays();
      let rect: Rect;
      let windowId: number | undefined;
      let label: string;

      if (a.window != null) {
        const windows = await getWindows({ onScreenOnly: false, includeAllLayers: true });
        const w = windows.find((w) => w.windowId === a.window);
        if (!w) throw new Error(`No window with id ${a.window}. Call list_windows for current ids.`);
        rect = { x: w.x, y: w.y, width: w.width, height: w.height };
        windowId = w.windowId;
        label = `window ${w.windowId} — ${w.app}${w.title ? `: ${w.title}` : ""}`;
      } else if (a.app) {
        const windows = await getWindows({ app: a.app, onScreenOnly: true });
        // Apps put small chrome-less helper windows on screen — link preview
        // bubbles, tooltips, drag proxies — which are indistinguishable from real
        // windows apart from being tiny and untitled. Prefer a titled window, then
        // the largest, so "screenshot the app" means the window a human would mean.
        const best = [...windows].sort((p, q) => {
          const titled = Number(!!q.title) - Number(!!p.title);
          if (titled !== 0) return titled;
          return q.width * q.height - p.width * p.height;
        })[0];
        const w = best;
        if (!w) {
          throw new Error(
            `No on-screen window found for app matching "${a.app}". ` +
              `Call list_windows to see what is open.`
          );
        }
        rect = { x: w.x, y: w.y, width: w.width, height: w.height };
        windowId = w.windowId;
        label = `window ${w.windowId} — ${w.app}${w.title ? `: ${w.title}` : ""}`;
      } else if (a.region) {
        const r = a.region;
        rect = { x: r.x, y: r.y, width: r.width, height: r.height };
        label = "custom region";
      } else if (a.all) {
        rect = unionOfDisplays(displays);
        label = `all ${displays.length} display(s)`;
      } else {
        const idx = a.display ?? displays.find((d) => d.main)?.index ?? 1;
        const d = displays.find((x) => x.index === idx);
        if (!d) {
          throw new Error(
            `No display with index ${idx}. Available: ${displays.map((x) => x.index).join(", ")}.`
          );
        }
        rect = { x: d.x, y: d.y, width: d.width, height: d.height };
        label = `display ${d.index}${d.main ? " (main)" : ""}`;
      }

      const shot = await capture(rect, {
        maxDimension: a.maxDimension,
        fullResolution: !!a.fullResolution,
        grid: !!a.grid,
        gridStep: a.gridStep,
        windowId,
        savePath: a.savePath,
      });

      const parts = [`Captured ${label}.`, "", coordinateGuide(shot)];

      // Knowing what is on screen makes the image far easier to act on.
      if (windowId == null) {
        const windows = await getWindows({ onScreenOnly: true });
        const inside = windows.filter(
          (w) =>
            w.x < rect.x + rect.width &&
            w.x + w.width > rect.x &&
            w.y < rect.y + rect.height &&
            w.y + w.height > rect.y
        );
        if (inside.length) {
          parts.push(
            "",
            `Windows in view (${inside.length}):`,
            ...inside
              .slice(0, 15)
              .map(
                (w) =>
                  `  [${w.windowId}] ${w.app}${w.title ? ` — ${w.title}` : ""} ` +
                  `at (${Math.round(w.x)}, ${Math.round(w.y)}) ${Math.round(w.width)}x${Math.round(w.height)}`
              )
          );
          if (inside.length > 15) parts.push(`  … and ${inside.length - 15} more`);
        }
      }
      if (shot.savedTo) parts.push("", `Saved to ${shot.savedTo}`);

      return [
        { type: "image", data: shot.base64, mimeType: "image/png" },
        { type: "text", text: parts.join("\n") },
      ];
    },
  },

  {
    name: "click",
    description:
      "Clicks at a global coordinate. The click goes to whatever window happens to be under " +
      "that point — no app support or scripting interface is required. " +
      COORD_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        x: num,
        y: num,
        button: { type: "string", enum: ["left", "right", "middle"], description: "Default left." },
        count: { ...num, description: "1 = single, 2 = double, 3 = triple click. Default 1." },
        modifiers,
        restore: {
          ...bool,
          description: "Move the pointer back where it was afterwards.",
        },
      },
      required: ["x", "y"],
    },
    handler: async (a) => json(await helper.send("click", a)),
  },

  {
    name: "move_mouse",
    description: "Moves the pointer without clicking — useful to trigger hover states. " + COORD_NOTE,
    inputSchema: {
      type: "object",
      properties: { x: num, y: num },
      required: ["x", "y"],
    },
    handler: async (a) => json(await helper.send("move", a)),
  },

  {
    name: "drag",
    description:
      "Presses at one point, drags along an interpolated path, and releases at another. " +
      "The interpolation matters: apps that track drags ignore a single jump. " +
      COORD_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        fromX: num,
        fromY: num,
        toX: num,
        toY: num,
        button: { type: "string", enum: ["left", "right", "middle"] },
        steps: { ...num, description: "Intermediate move events. Default 25." },
        modifiers,
      },
      required: ["fromX", "fromY", "toX", "toY"],
    },
    handler: async (a) => json(await helper.send("drag", a, 60_000)),
  },

  {
    name: "scroll",
    description:
      "Scrolls the wheel, optionally after moving the pointer so the scroll lands in the " +
      "right view. Positive dy scrolls up, negative dy scrolls down.",
    inputSchema: {
      type: "object",
      properties: {
        x: { ...num, description: "Move the pointer here first (global points)." },
        y: num,
        dx: { ...num, description: "Horizontal amount. Default 0." },
        dy: { ...num, description: "Vertical amount. Positive = up, negative = down." },
        units: { type: "string", enum: ["line", "pixel"], description: "Default line." },
        modifiers,
      },
    },
    handler: async (a) => json(await helper.send("scroll", a)),
  },

  {
    name: "type_text",
    description:
      "Types text into whatever currently has keyboard focus. Click the field first. " +
      "Sends real Unicode key events, so accented and non-Latin characters work regardless " +
      "of the active keyboard layout. For long text prefer method 'paste', which is far " +
      "faster and immune to per-character drops.\n\n" +
      "IMPORTANT: keystrokes go to whichever app is frontmost at that moment, which is not " +
      "always the one you last clicked — other software can steal focus. Pass `app` to " +
      "activate the intended target first and refuse to type if it is not frontmost. The " +
      "response always reports which app actually received the text.",
    inputSchema: {
      type: "object",
      properties: {
        text: str,
        app: {
          ...str,
          description:
            "Activate this app first, then verify it is frontmost before typing, and fail " +
            "rather than send the text somewhere unintended. Strongly recommended.",
        },
        method: {
          type: "string",
          enum: ["keystroke", "paste"],
          description:
            "'keystroke' types character by character (default). 'paste' puts the text on the " +
            "clipboard, presses cmd+V, then restores the previous clipboard contents.",
        },
        delay: {
          ...num,
          description:
            "Milliseconds between keystrokes. Default 20, which measured 13/13 exact in " +
            "testing; lower values occasionally drop characters. Raise it for slow apps.",
        },
        pressEnter: { ...bool, description: "Press Return once the text is entered." },
      },
      required: ["text"],
    },
    handler: async (a) => {
      const method = a.method ?? "keystroke";
      const guard = await focusTarget(a.app);
      let result: Record<string, any>;

      if (method === "paste") {
        const previous = await helper.send("clipget");
        await helper.send("clipset", { text: a.text });
        await sleep(60);
        const res = await helper.send("key", { key: "v", modifiers: ["cmd"], ...guard });
        // Restoring too eagerly can beat the target app to the clipboard.
        await sleep(250);
        if (previous.hasText) await helper.send("clipset", { text: previous.text });
        result = {
          method: "paste",
          characters: String(a.text).length,
          clipboardRestored: !!previous.hasText,
          frontmostApp: res.frontmostApp,
        };
      } else {
        const res = await helper.send(
          "type",
          { text: a.text, delay: a.delay, ...guard },
          120_000
        );
        result = { method: "keystroke", characters: res.typed, frontmostApp: res.frontmostApp };
      }

      if (a.pressEnter) {
        await sleep(80);
        await helper.send("key", { key: "return", ...guard });
        result.pressedEnter = true;
      }
      return json(result);
    },
  },

  {
    name: "press_key",
    description:
      "Presses a named key, optionally with modifiers — Return, Tab, Escape, arrows, " +
      "function keys, or a single character key. Use this for shortcuts such as cmd+S, " +
      "and for navigation that typing cannot express.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          ...str,
          description:
            "Key name: return, tab, space, delete, forwarddelete, escape, up, down, left, right, " +
            "home, end, pageup, pagedown, f1-f20, or a single character like 'a' or '/'.",
        },
        modifiers,
        count: { ...num, description: "Repeat the press this many times. Default 1." },
        app: {
          ...str,
          description:
            "Activate this app first and refuse to send the key if it is not frontmost.",
        },
      },
      required: ["key"],
    },
    handler: async (a) => {
      const guard = await focusTarget(a.app);
      return json(await helper.send("key", { ...a, ...guard }, 60_000));
    },
  },

  {
    name: "get_mouse_position",
    description: "Returns the current pointer position in global points.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const res = await helper.send("mouse");
      return json({ x: res.x, y: res.y });
    },
  },

  {
    name: "activate_app",
    description:
      "Brings an application to the front and unhides it. Do this before typing so the " +
      "keystrokes reach the intended app.",
    inputSchema: {
      type: "object",
      properties: {
        name: { ...str, description: "App name, e.g. 'Safari'. Exact match preferred." },
        pid: num,
        bundleId: str,
      },
    },
    handler: async (a) => json(await helper.send("activate", a)),
  },

  {
    name: "set_window_bounds",
    description:
      "Moves, resizes and/or raises an application window via the Accessibility API. " +
      "Useful to put a window at a known position before interacting, so coordinates stay " +
      "stable across a session. Returns the geometry the app actually settled on, which " +
      "may differ from what was requested since apps can clamp or refuse it. " +
      "Prefer passing windowId when the app has more than one window.",
    inputSchema: {
      type: "object",
      properties: {
        windowId: {
          ...num,
          description:
            "windowId from list_windows — the reliable way to target a specific window. " +
            "Implies the owning app, so name/pid are not needed.",
        },
        name: str,
        pid: num,
        bundleId: str,
        windowIndex: {
          ...num,
          description:
            "Fallback when no windowId is given: 0 = the app's frontmost window. Default 0. " +
            "Ambiguous if the app has several windows.",
        },
        x: num,
        y: num,
        width: num,
        height: num,
        raise: { ...bool, description: "Raise and activate the window. Default true." },
      },
    },
    handler: async (a) => json(await helper.send("setwindow", a)),
  },

  {
    name: "get_clipboard",
    description: "Reads the current text contents of the system clipboard.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => json(await helper.send("clipget")),
  },

  {
    name: "set_clipboard",
    description: "Replaces the text contents of the system clipboard.",
    inputSchema: {
      type: "object",
      properties: { text: str },
      required: ["text"],
    },
    handler: async (a) => json(await helper.send("clipset", a)),
  },
];
