import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Skills-over-MCP: the skill text is served as a plain MCP resource + prompt so any
 * client can fetch it, not only Claude Code. (MCP has no standard "skills" primitive as
 * of SDK 1.30; resources/prompts are the portable carrier. Any future skills extension
 * should be additive, not a replacement.)
 */
export const SKILL_URI = "skill://clickr/SKILL.md";
export const SKILL_PROMPT = "clickr-skill";

const here = dirname(fileURLToPath(import.meta.url));

/** Read SKILL.md from the packaged skills dir (single source; shipped via package.json "files"). */
export function readSkill(): string {
  const p = join(here, "..", "skills", "Clickr", "SKILL.md");
  if (!existsSync(p)) throw new Error(`SKILL.md not found at ${p}`);
  return readFileSync(p, "utf8");
}
