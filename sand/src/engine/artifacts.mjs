/**
 * Artifacts: the files an agent leaves behind in its workspace.
 *
 * The event stream says what an agent *did*; the artifacts are what it
 * actually produced. A run that writes a weather page is only legible if
 * you can see the page, so this module lists workspace files and reads
 * them back for the UI.
 *
 * Two things are deliberately excluded: harness bookkeeping (`.git`,
 * `.lean`, `.gm-pi`), which is not the agent's output, and anything that
 * resolves outside the workspace, which a path traversal would try.
 */

import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

/** Harness state and VCS bookkeeping -- in every workspace, never the point. */
const EXCLUDED_DIRS = new Set([".git", ".lean", ".gm-pi", "node_modules", "__pycache__"]);

/** Rendered in an iframe rather than shown as source. */
const HTML_EXTS = new Set([".html", ".htm"]);

const TEXT_EXTS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".jsx", ".tsx", ".py", ".rb", ".sh", ".bash",
  ".json", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf",
  ".md", ".markdown", ".txt", ".rst", ".csv", ".tsv", ".xml", ".svg",
  ".css", ".sql", ".gitignore",
]);

/** Read the whole file only when it is small enough to be worth showing. */
export const MAX_INLINE_BYTES = 512 * 1024;

export function classify(name) {
  const ext = extname(name).toLowerCase();
  if (HTML_EXTS.has(ext)) return "html";
  if (TEXT_EXTS.has(ext) || !ext) return "text";
  return "binary";
}

/**
 * Every file an agent produced, newest first.
 *
 * A workspace is small by construction, so the walk is unbounded apart
 * from skipping bookkeeping directories.
 */
export async function listArtifacts(workspace) {
  if (!existsSync(workspace)) return [];

  const found = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // A directory we cannot read is not worth failing the whole listing.
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await stat(full);
        const rel = relative(workspace, full).split(sep).join("/");
        found.push({
          name: rel,
          size: info.size,
          modified: info.mtimeMs,
          kind: classify(entry.name),
          renderable: info.size <= MAX_INLINE_BYTES,
        });
      } catch {
        // Vanished between readdir and stat; nothing to report.
      }
    }
  }

  await walk(workspace);
  found.sort((a, b) => b.modified - a.modified);
  return found;
}

/**
 * Read one artifact, refusing anything that escapes the workspace.
 *
 * `resolve` collapses `..` before the check, so a crafted name cannot walk
 * out of the sandbox and read arbitrary files off the host.
 */
export async function readArtifact(workspace, name) {
  const root = resolve(workspace);
  const target = resolve(root, name);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error("artifact path escapes the workspace");
  }
  if (!existsSync(target)) throw new Error("no such artifact");

  const info = await stat(target);
  if (!info.isFile()) throw new Error("not a file");
  if (info.size > MAX_INLINE_BYTES) {
    throw new Error(`artifact is ${info.size} bytes; too large to display`);
  }

  const kind = classify(target);
  if (kind === "binary") throw new Error("artifact is not text");

  return { name, kind, size: info.size, content: await readFile(target, "utf8") };
}
