import { statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";

import type { ProjectSnapshot, SnapshotFileMeta } from "./types";

const DEFAULT_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".opencode",
]);

const DEFAULT_ALLOWED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
]);

export interface SnapshotOptions {
  maxDepth?: number;
  maxFiles?: number;
  allowedExtensions?: Set<string>;
  skipDirs?: Set<string>;
}

function shouldSkip(entryPath: string, skipDirs: Set<string>): boolean {
  const parts = entryPath.split(path.sep);
  return parts.some((part) => skipDirs.has(part));
}

export async function collectProjectSnapshot(
  projectRoot: string,
  options: SnapshotOptions = {},
): Promise<ProjectSnapshot> {
  const maxDepth = options.maxDepth ?? 5;
  const maxFiles = options.maxFiles ?? 600;
  const allowedExtensions = options.allowedExtensions ?? DEFAULT_ALLOWED_EXTENSIONS;
  const skipDirs = options.skipDirs ?? DEFAULT_SKIP_DIRS;

  const files: SnapshotFileMeta[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: projectRoot, depth: 0 }];

  while (stack.length > 0 && files.length < maxFiles) {
    const { dir, depth } = stack.shift()!;
    if (depth > maxDepth) continue;

    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const nextPath = path.join(dir, entry.name);
      if (shouldSkip(nextPath, skipDirs)) continue;

      if (entry.isDirectory()) {
        stack.push({ dir: nextPath, depth: depth + 1 });
        continue;
      }

      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!allowedExtensions.has(ext)) continue;

      try {
        const stats = statSync(nextPath);
        files.push({
          path: nextPath,
          relativePath: path.relative(projectRoot, nextPath),
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          inode: typeof stats.ino === "number" ? stats.ino : undefined,
        });
      } catch {
        continue;
      }

      if (files.length >= maxFiles) break;
    }
  }

  return {
    projectRoot,
    generatedAt: Date.now(),
    files,
  };
}

export async function readSnapshotFileHead(
  filePath: string,
  maxBytes: number,
): Promise<string> {
  try {
    const buffer = await readFile(filePath);
    return buffer.toString("utf8", 0, Math.min(buffer.length, maxBytes));
  } catch {
    return "";
  }
}
