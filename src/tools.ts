import {
  capture,
  captureRaw,
  coordinateGuide,
  DEFAULT_MAX_DIMENSION,
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
/**
 * Compact JSON for list-shaped results.
 *
 * Indented JSON roughly triples the size of a long list, and every token spent on
 * whitespace is a token not spent on the task. Measured: 54 OCR lines cost ~1389
 * tokens pretty-printed versus ~270 as compact lines.
 */
const compact = (o: unknown): Content[] => [{ type: "text", text: JSON.stringify(o) }];

/**
 * Content hash of the last image returned for a given target.
 *
 * Images stay in the conversation and are re-sent on every later turn, so returning
 * a second, identical image is pure waste — the first one is still visible. When a
 * re-capture matches, we say so in text and skip the image entirely.
 */
const lastImageHash = new Map<string, string>();

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

/**
 * Guards against layout reflow, which expectGeometry structurally cannot see: inserting
 * a toolbar shifts every control below it while the display layout stays identical.
 * Asserting on what the coordinate should resolve to catches that; asserting on the
 * display cannot. Opt-in, because the surfaces clickr exists for — canvas, games,
 * remote desktop — expose no accessibility tree to assert against.
 */
const expectTarget = {
  expectRole: {
    ...str,
    description:
      'AX role the target should still have, as reported by find_elements ("AXButton"; ' +
      '"button" is accepted too). The element under the point is checked BEFORE the ' +
      'event is posted and the action is refused on a mismatch. Pass this whenever the ' +
      'coordinate came from find_elements — it is the only guard against a page ' +
      'reflowing between the lookup and the click, which expectGeometry cannot detect.',
  },
  expectTitle: {
    ...str,
    description:
      "Text the target should still carry — matched case-insensitively as a substring " +
      "of its title, description or value (or its parent's). Combine with expectRole " +
      "to pin down which control, not merely which kind.",
  },
} as const;

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
      const res = await helper.send("displays");
      const displays = res.displays as any[];
      const union = unionOfDisplays(displays as any);
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
        geometry: res.geometry,
        note:
          "bounds are in global points — pass them straight to screenshot or click. " +
          "`geometry` fingerprints this display layout: pass it to click/drag/scroll as " +
          "expectGeometry and the action is refused if the layout changed in the meantime.",
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
      "Regions up to " + DEFAULT_MAX_DIMENSION + " points come back at 1:1 (one image pixel = " +
      "one point), which is the reliable way to measure a small UI element precisely. " +
      "Turn on `grid` to overlay labelled global coordinates directly onto the image.\n\n" +
      "COST: an image costs roughly (width*height)/750 tokens AND stays in the conversation, " +
      "so it is re-sent on every later turn — 30 full-screen captures can mean 50k+ tokens " +
      "carried by every subsequent request. Before reaching for this tool:\n" +
      "  - find_elements returns buttons/fields with exact click coordinates as text, " +
      "typically for a tenth of the cost. Prefer it for locating things.\n" +
      "  - read_text OCRs a region locally and returns text only, no image.\n" +
      "  - click already reports the element it hit, so verification rarely needs a capture.\n" +
      "When you do capture, prefer a tight region over a whole display, and keep " +
      "maxDimension small. Re-capturing an unchanged region returns text, not a new image.",
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
            `Longest edge of the returned image in pixels. Default ${DEFAULT_MAX_DIMENSION} ` +
            `(~590 tokens for a full display; 1400 would cost ~1800). Lower is cheaper.`,
        },
        skipIfUnchanged: {
          ...bool,
          description:
            "Default true. If this exact region is pixel-identical to the previous capture, " +
            "return a short text note instead of an identical image, since the earlier image " +
            "is still in the conversation. Set false to force a fresh image.",
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

      // If this exact target looks identical to what we already sent, don't send
      // the pixels again — the previous image is still in the conversation.
      const cacheKey = JSON.stringify([
        windowId ?? null,
        rect,
        shot.imageWidth,
        shot.imageHeight,
        shot.gridStep ?? null,
      ]);
      if (a.skipIfUnchanged !== false && lastImageHash.get(cacheKey) === shot.hash) {
        return text(
          `Unchanged: ${label} is pixel-identical to the last capture of the same ` +
            `region (hash ${shot.hash}), so the image was not re-sent — scroll back to ` +
            `that earlier screenshot, it is still accurate.\n\n` +
            coordinateGuide(shot) +
            `\n\nPass skipIfUnchanged: false to force a fresh image.`
        );
      }
      lastImageHash.set(cacheKey, shot.hash);

      const parts = [`Captured ${label}.`, "", coordinateGuide(shot)];

      // A window capture composites the window unoccluded, so it can show content
      // that is really hidden behind something else — and a click computed from it
      // would land on whatever is actually on top.
      if (windowId != null) {
        try {
          const occ = await helper.send("occlusion", { windowId });
          if (occ.occluded) {
            const names = (occ.occluders as any[])
              .map((o) => o.app + (o.title ? ` (${o.title})` : ""))
              .slice(0, 4);
            parts.push(
              "",
              `WARNING: this window is ${Math.round((occ.coveredFraction as number) * 100)}% ` +
                `covered by ${names.join(", ")}. The capture shows the window as if ` +
                `unobstructed, but a click at these coordinates would hit the window on ` +
                `top. Raise this window first (set_window_bounds with raise: true), or ` +
                `capture by region to see what is actually visible.`
            );
          }
        } catch {
          // Occlusion info is advisory; never fail a capture over it.
        }
      }

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
    name: "find_elements",
    description:
      "Finds UI controls through the macOS Accessibility API and returns them as TEXT with " +
      "exact click coordinates (centerX/centerY, ready to pass to click). " +
      "PREFER THIS OVER screenshot for locating anything: it typically costs a tenth as " +
      "much, it is exact rather than eyeballed, and it does not leave an image in the " +
      "conversation forever. Works for native apps and for web pages in Chrome/Safari, " +
      "which expose the DOM as accessibility elements.\n\n" +
      "Filter by role (AXButton, AXTextField, AXCheckBox, AXLink, AXMenuItem, ...) and/or " +
      "titleContains. Narrow with windowId when an app has several windows.\n\n" +
      "LOOKING FOR SOMETHING INSIDE A WEB PAGE? Pass webContent:true. The search is " +
      "breadth-first and a browser's toolbar, tabs and menu bar sit above the page, so a " +
      "plain search for a role the browser also uses for its own controls (AXButton, " +
      "AXGroup, AXTextField) spends the whole result cap on browser chrome and never " +
      "reaches the page — which looks identical to the page exposing nothing. " +
      "webContent:true starts the walk at the page's web areas instead.",
    inputSchema: {
      type: "object",
      properties: {
        name: { ...str, description: "App name, e.g. 'Google Chrome'." },
        pid: num,
        bundleId: str,
        windowId: {
          ...num,
          description: "Restrict the search to this window (much faster than the whole app).",
        },
        windowIndex: { ...num, description: "Restrict to the app's Nth window (0 = frontmost)." },
        role: {
          ...str,
          description:
            "Accessibility role or subrole, e.g. AXButton, AXTextField, AXLink, AXCheckBox, " +
            "AXRadioButton, AXMenuItem, AXStaticText. Matched case-insensitively.",
        },
        titleContains: {
          ...str,
          description:
            "Substring matched against the element's title, description, value or help text.",
        },
        onlyActionable: {
          ...bool,
          description: "Only elements that can be pressed (have an AXPress action).",
        },
        region: {
          type: "object",
          description: "Only elements intersecting this rectangle of global points.",
          properties: { x: num, y: num, width: num, height: num },
          required: ["x", "y", "width", "height"],
        },
        webContent: {
          ...bool,
          description:
            "Start the search at the page's web areas instead of the application root, " +
            "skipping the browser's own toolbar, tabs and menu bar. Use this for anything " +
            "inside a web page or an Electron app. Reported depths become relative to the " +
            "page. If it finds no web area, scope comes back 'webContent (none found)' — " +
            "then the content genuinely is not in the accessibility tree, and a tight " +
            "screenshot region is the fallback.",
        },
        maxResults: { ...num, description: "Cap on returned elements. Default 40." },
        maxDepth: { ...num, description: "Tree depth limit. Default 18." },
      },
    },
    handler: async (a) => compact(await helper.send("elements", a, 30_000)),
  },

  {
    name: "element_at",
    description:
      "Describes the accessibility element at a global coordinate — role, title, value and " +
      "state — as text. Use it to confirm what is under a point before clicking, or what a " +
      "click landed on, without spending an image on it.",
    inputSchema: {
      type: "object",
      properties: { x: num, y: num },
      required: ["x", "y"],
    },
    handler: async (a) => compact(await helper.send("elementat", a)),
  },

  {
    name: "read_text",
    description:
      "Reads the text on screen using macOS's on-device text recognition and returns it as " +
      "TEXT — no image is sent. Use this to answer questions like 'what does the error say', " +
      "'did the title save', 'what is in that list' for a fraction of a screenshot's cost, " +
      "and when the content is not exposed through the accessibility tree (canvas, video, " +
      "remote desktop, images).\n\n" +
      "By default returns plain text in reading order, which is the cheapest form. Set " +
      "withCoordinates to also get a click point per line — useful for locating something, " +
      "but several times more expensive, so keep the region tight when you do.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "object",
          description: "Rectangle of global points to read. Prefer a tight region.",
          properties: { x: num, y: num, width: num, height: num },
          required: ["x", "y", "width", "height"],
        },
        display: { ...num, description: "Read a whole display instead of a region." },
        window: { ...num, description: "Read a specific window by windowId." },
        app: { ...str, description: "Read that app's frontmost window." },
        withCoordinates: {
          ...bool,
          description:
            "Include a click point per line (centerX/centerY). Costs several times more " +
            "than plain text — only use it when you need to click what you read.",
        },
        minConfidence: { ...num, description: "Drop lines below this confidence. Default 0.3." },
        fast: { ...bool, description: "Faster, less accurate recognition." },
        languages: {
          type: "array",
          items: str,
          description: "Recognition languages, e.g. ['en-US','de-DE']. Default: system.",
        },
      },
    },
    handler: async (a) => {
      const displays = await getDisplays();
      let rect: Rect;
      let windowId: number | undefined;

      if (a.window != null || a.app) {
        const windows = await getWindows({
          app: a.app,
          onScreenOnly: a.window == null,
          includeAllLayers: a.window != null,
        });
        const w =
          a.window != null
            ? windows.find((w) => w.windowId === a.window)
            : [...windows].sort(
                (p, q) =>
                  Number(!!q.title) - Number(!!p.title) ||
                  q.width * q.height - p.width * p.height
              )[0];
        if (!w) throw new Error(`No window found for ${a.window ?? a.app}.`);
        rect = { x: w.x, y: w.y, width: w.width, height: w.height };
        windowId = w.windowId;
      } else if (a.region) {
        rect = a.region;
      } else {
        const d =
          displays.find((x) => x.index === (a.display ?? -1)) ??
          displays.find((x) => x.main) ??
          displays[0];
        rect = { x: d.x, y: d.y, width: d.width, height: d.height };
      }

      // OCR runs on the raw, full-resolution capture for accuracy; only text leaves.
      const raw = await captureRaw(rect, windowId);
      try {
        const res = await helper.send(
          "ocr",
          {
            input: raw.path,
            originX: rect.x,
            originY: rect.y,
            scale: raw.scale,
            minConfidence: a.minConfidence,
            fast: !!a.fast,
            languages: a.languages,
          },
          60_000
        );
        const lines = (res.lines as any[]) ?? [];
        if (!lines.length) return text("No text recognised in that region.");

        if (a.withCoordinates) {
          // One compact line each: text, then a click point.
          const body = lines
            .map((l) => `${l.text}\t@${l.centerX},${l.centerY}`)
            .join("\n");
          return text(
            `${lines.length} line(s) in region x=${rect.x} y=${rect.y} ` +
              `w=${rect.width} h=${rect.height}. ` +
              `Format: text <TAB> @clickX,clickY (global points).\n\n${body}`
          );
        }
        return text(lines.map((l) => l.text).join("\n"));
      } finally {
        raw.cleanup();
      }
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
        expectGeometry: {
          ...str,
          description:
            'Geometry token from list_displays/find_elements taken when these coordinates ' +
            'were measured. If the display layout has changed since, the action is refused ' +
            'instead of landing on whatever moved underneath.',
        },
        ...expectTarget,
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
      properties: { x: num, y: num, expectGeometry: str },
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
        expectGeometry: {
          ...str,
          description:
            'Geometry token from list_displays/find_elements taken when these coordinates ' +
            'were measured. If the display layout has changed since, the action is refused ' +
            'instead of landing on whatever moved underneath.',
        },
        ...expectTarget,
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
        expectGeometry: {
          ...str,
          description:
            'Geometry token from list_displays/find_elements taken when these coordinates ' +
            'were measured. If the display layout has changed since, the action is refused ' +
            'instead of landing on whatever moved underneath.',
        },
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
            "clipboard, presses cmd+V, then restores the previous clipboard contents. " +
            "ALWAYS use 'paste' for any field with autocomplete or an IME — URL bars, search " +
            "boxes, file-path fields. Such fields re-enter and reorder characters between " +
            "keystrokes, so typed text arrives scrambled ('https://github.com/new' became " +
            "'thub.co/gim/new/' in Chrome's omnibox). Paste is also safer for accented and " +
            "non-Latin text, and much faster for long strings.",
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
