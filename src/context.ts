import * as path from "path";
import { readFile } from "node:fs/promises";
import type { PluginInput } from "./types";
import { createContextLogger } from "./logger";

const log = createContextLogger("context");

type ContextInput = Pick<PluginInput, "$" | "directory">;

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function headLines(text: string, maxLines: number): string {
  return text.split(/\r?\n/).slice(0, maxLines).join("\n");
}

/**
 * Gather project context for the architect agents.
 * Collects file tree, config files, and entry point source code
 * so architects can design against the real codebase.
 *
 * All I/O is run in parallel to minimize startup latency.
 * Uses ctx.directory — the CWD where the user launched opencode — as the
 * project root. ctx.worktree may point to an opencode-managed git worktree
 * (e.g. ~/.opencode/worktrees/<id>) rather than the user's project folder.
 */
export async function gatherProjectContext(
  ctx: ContextInput,
): Promise<string> {
  const worktree = path.resolve(ctx.directory);

  const configFiles = [
    "package.json",
    "tsconfig.json",
    "opencode.json",
    "README.md",
  ] as const;

  const entryPoints = [
    "src/index.ts",
    "src/main.ts",
    "src/app.ts",
    "index.ts",
    "main.ts",
  ] as const;

  // Run all I/O in parallel: file tree + config files + entry points
  const [treeResult, configResults, entryResults] = await Promise.allSettled([
    // File tree: scoped strictly to worktree, max depth 8 to avoid deep traversal
    ctx
      .$`find ${worktree} -maxdepth 8 -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" \) -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/.cache/*" | sort | head -100`
      .text(),
    Promise.all(configFiles.map((file) => readFileIfExists(path.join(worktree, file)))),
    Promise.all(entryPoints.map((entry) => readFileIfExists(path.join(worktree, entry)))),
  ]);

  const sections: string[] = [];

  // Process file tree
  if (treeResult.status === "fulfilled" && treeResult.value.trim()) {
    sections.push(
      `## File Structure\n\`\`\`\n${treeResult.value.trim()}\n\`\`\``,
    );
    log.debug("Gathered file structure");
  } else if (treeResult.status === "rejected") {
    log.warn("Failed to gather file structure", treeResult.reason);
  }

  const configTexts = configResults.status === "fulfilled" ? configResults.value : [];

  // Process config files
  for (let i = 0; i < configFiles.length; i++) {
    const content = configTexts[i];
    const file = configFiles[i];
    if (typeof content === "string" && content.trim()) {
      const ext = file.endsWith(".md") ? "markdown" : "json";
      sections.push(
        `## ${file}\n\`\`\`${ext}\n${content.slice(0, 2000)}\n\`\`\``,
      );
      log.debug(`Gathered config file: ${file}`);
    } else {
      log.debug(`Config file not found or unreadable: ${file}`);
    }
  }

  const entryTexts = entryResults.status === "fulfilled" ? entryResults.value : [];

  // Process entry points, stop after 3 hits
  let entryCount = 0;
  for (let i = 0; i < entryPoints.length; i++) {
    if (entryCount >= 3) break;
    const content = entryTexts[i];
    const entry = entryPoints[i];
    if (typeof content === "string" && content.trim()) {
      sections.push(
        `## ${entry}\n\`\`\`typescript\n${headLines(content, 200)}\n\`\`\``,
      );
      entryCount++;
      log.debug(`Gathered entry point: ${entry}`);
    } else {
      log.debug(`Entry point not found: ${entry}`);
    }
  }

  if (sections.length === 0) {
    log.warn("No project context available");
    return "(No project context available — empty or unrecognized project structure)";
  }

  log.info(`Gathered ${sections.length} context sections`);
  return sections.join("\n\n");
}
