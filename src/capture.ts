import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getDisplays, helper, type Display } from "./helper.js";

const run = promisify(execFile);

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureResult {
  base64: string;
  imageWidth: number;
  imageHeight: number;
  /** Multiply an image pixel offset by this to get a global-point offset. */
  pointsPerImagePixel: number;
  rect: Rect;
  savedTo?: string;
  gridStep?: number;
}

/** The smallest rectangle covering every attached display. */
export function unionOfDisplays(displays: Display[]): Rect {
  const minX = Math.min(...displays.map((d) => d.x));
  const minY = Math.min(...displays.map((d) => d.y));
  const maxX = Math.max(...displays.map((d) => d.x + d.width));
  const maxY = Math.max(...displays.map((d) => d.y + d.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Backing scale of the display containing a rect's centre (2 on Retina). */
export function scaleForRect(rect: Rect, displays: Display[]): number {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const hit = displays.find(
    (d) => cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height
  );
  return hit?.scale ?? displays.find((d) => d.main)?.scale ?? 1;
}

const GRID_STEPS = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];

/** Picks a round grid spacing that lands roughly every 90px in the output image. */
function chooseGridStep(pointsPerImagePixel: number, longEdgePoints: number): number {
  const ideal = pointsPerImagePixel * 90;
  let best = GRID_STEPS[0];
  for (const s of GRID_STEPS) {
    if (Math.abs(s - ideal) < Math.abs(best - ideal)) best = s;
    if (s > longEdgePoints / 2) break;
  }
  return best;
}

export interface CaptureOptions {
  /** Longest edge of the returned image, in pixels. */
  maxDimension?: number;
  /** Capture at native device pixels instead of points (for fine measurement). */
  fullResolution?: boolean;
  /** Overlay a labelled global-coordinate grid. */
  grid?: boolean;
  gridStep?: number;
  /** Capture a specific window by id, compositing it out of the stack. */
  windowId?: number;
  /** Also write the PNG here. */
  savePath?: string;
}

/**
 * Captures a rectangle of global point space and returns a PNG whose pixels map
 * back to global coordinates by a single reported scalar.
 */
export async function capture(rect: Rect, opts: CaptureOptions = {}): Promise<CaptureResult> {
  if (!(rect.width >= 1) || !(rect.height >= 1)) {
    throw new Error(
      `capture region must be at least 1x1 points (got ${rect.width}x${rect.height})`
    );
  }

  const displays = await getDisplays();
  const deviceScale = scaleForRect(rect, displays);
  const tmp = mkdtempSync(join(tmpdir(), "clickr-"));
  const rawPath = join(tmp, "raw.png");
  const outPath = opts.savePath ?? join(tmp, "out.png");

  try {
    // -x: no shutter sound. -o: no window shadow. -R takes GLOBAL POINTS and
    // happily accepts negative origins on multi-display setups.
    const args = ["-x"];
    if (opts.windowId != null) {
      args.push("-o", "-l", String(opts.windowId));
    } else {
      args.push(`-R${rect.x},${rect.y},${rect.width},${rect.height}`);
    }
    args.push(rawPath);

    try {
      await run("/usr/sbin/screencapture", args, { timeout: 20_000 });
    } catch (e: any) {
      throw new Error(
        `screencapture failed: ${e?.stderr || e?.message || e}. ` +
          `This usually means Screen Recording permission is missing — run check_permissions.`
      );
    }

    // Work out the output size. In point mode 1 image pixel == 1 point unless
    // the region is larger than maxDimension, in which case we scale uniformly.
    const maxDim = Math.max(64, opts.maxDimension ?? 1400);
    const longEdge = Math.max(rect.width, rect.height);
    let factor: number;
    if (opts.fullResolution) {
      factor = deviceScale;
      const longPixels = longEdge * deviceScale;
      if (longPixels > maxDim) factor = maxDim / longEdge;
    } else {
      factor = longEdge > maxDim ? maxDim / longEdge : 1;
    }

    const targetW = Math.max(1, Math.round(rect.width * factor));
    const targetH = Math.max(1, Math.round(rect.height * factor));
    const pointsPerImagePixel = rect.width / targetW;

    const gridStep = opts.grid
      ? opts.gridStep ?? chooseGridStep(pointsPerImagePixel, longEdge)
      : undefined;

    const res = await helper.send("image", {
      input: rawPath,
      output: outPath,
      targetW,
      targetH,
      ...(gridStep
        ? {
            grid: {
              originX: rect.x,
              originY: rect.y,
              pointsPerPixel: pointsPerImagePixel,
              step: gridStep,
            },
          }
        : {}),
    });

    const base64 = readFileSync(outPath).toString("base64");
    return {
      base64,
      imageWidth: res.width as number,
      imageHeight: res.height as number,
      pointsPerImagePixel,
      rect,
      savedTo: opts.savePath,
      gridStep,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Human-readable instructions for turning image pixels back into click targets. */
export function coordinateGuide(r: CaptureResult): string {
  const p = r.pointsPerImagePixel;
  const exact = Math.abs(p - 1) < 1e-9;
  const lines = [
    `Region captured: global points x=${r.rect.x} y=${r.rect.y} ` +
      `w=${r.rect.width} h=${r.rect.height}`,
    `Image size: ${r.imageWidth} x ${r.imageHeight} px`,
  ];
  if (exact) {
    lines.push(
      `Scale: 1 image pixel = 1 point (exact).`,
      `To click something at image pixel (px, py):`,
      `  x = ${r.rect.x} + px`,
      `  y = ${r.rect.y} + py`
    );
  } else {
    lines.push(
      `Scale: 1 image pixel = ${p.toFixed(4)} points.`,
      `To click something at image pixel (px, py):`,
      `  x = ${r.rect.x} + px * ${p.toFixed(4)}`,
      `  y = ${r.rect.y} + py * ${p.toFixed(4)}`,
      `For pixel-accurate work on a small target, take a second screenshot of a ` +
        `small region around it — regions under ${1400} points come back at 1:1.`
    );
  }
  if (r.gridStep) {
    lines.push(
      `A coordinate grid is overlaid: labelled lines every ${r.gridStep} points ` +
        `(bright lines every ${r.gridStep * 5}). Labels are already in global ` +
        `coordinates — read them directly, no conversion needed.`
    );
  }
  return lines.join("\n");
}
