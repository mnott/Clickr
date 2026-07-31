import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Located relative to the package root so it works from dist/ or src/. */
function helperPath(): string {
  const candidates = [
    join(here, "..", "bin", "clickr-helper"),
    join(here, "..", "..", "bin", "clickr-helper"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(
    `clickr-helper binary not found (looked in: ${candidates.join(", ")}). ` +
      `Run "npm run build:native" in the clickr package directory.`
  );
}

type Pending = {
  resolve: (v: Record<string, any>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * Long-lived connection to the native helper. Kept alive between calls so
 * repeated clicks/keystrokes cost nothing but a line of JSON, and so macOS
 * attributes permissions to one stable process.
 */
class Helper {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private nextId = 1;

  private start(): ChildProcessWithoutNullStreams {
    // Never leak an API key into a spawned process.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    const proc = spawn(helperPath(), [], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      process.stderr.write(`[clickr-helper] ${chunk}`);
    });
    proc.on("exit", (code, signal) => {
      const err = new Error(
        `clickr-helper exited unexpectedly (code=${code} signal=${signal})`
      );
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      if (this.proc === proc) this.proc = null;
    });
    proc.on("error", (e) => {
      process.stderr.write(`[clickr-helper] spawn error: ${e.message}\n`);
      if (this.proc === proc) this.proc = null;
    });

    return proc;
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;

      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stderr.write(`[clickr-helper] unparseable line: ${line}\n`);
        continue;
      }

      const entry = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
      if (!entry) continue;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);

      if (msg.ok) entry.resolve(msg);
      else entry.reject(new Error(msg.error ?? "unknown helper error"));
    }
  }

  async send(
    cmd: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000
  ): Promise<Record<string, any>> {
    if (!this.proc) {
      this.proc = this.start();
      this.buffer = "";
    }
    const proc = this.proc;
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`clickr-helper timed out after ${timeoutMs}ms on '${cmd}'`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      proc.stdin.write(JSON.stringify({ ...params, cmd, id }) + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  dispose() {
    this.proc?.kill();
    this.proc = null;
  }
}

export const helper = new Helper();

export interface Display {
  index: number;
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  scale: number;
  main: boolean;
}

export interface WindowInfo {
  windowId: number;
  app: string;
  title: string;
  pid: number;
  layer: number;
  x: number;
  y: number;
  width: number;
  height: number;
  onScreen: boolean;
}

export async function getDisplays(): Promise<Display[]> {
  const res = await helper.send("displays");
  return res.displays as Display[];
}

export async function getWindows(opts: {
  app?: string;
  onScreenOnly?: boolean;
  includeAllLayers?: boolean;
} = {}): Promise<WindowInfo[]> {
  const res = await helper.send("windows", opts);
  return res.windows as WindowInfo[];
}
