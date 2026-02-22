import * as fs from "fs";
import * as path from "path";
import type { DiffResult, PreviewResult, ScaffoldingFile } from "./types";
import { createContextLogger } from "../logger";

const log = createContextLogger("differ");

/**
 * Simple unified diff format generator
 */
function generateUnifiedDiff(
  filePath: string,
  oldContent: string | undefined,
  newContent: string
): string {
  const lines: string[] = [];
  const timestamp = new Date().toISOString();
  
  lines.push(`--- a/${filePath}`);
  lines.push(`+++ b/${filePath}`);
  lines.push(`@@ -1,${oldContent ? oldContent.split("\n").length : 0} +1,${newContent.split("\n").length} @@`);
  
  const oldLines = oldContent ? oldContent.split("\n") : [];
  const newLines = newContent.split("\n");
  
  // Simple line-by-line diff
  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    
    if (oldLine === undefined) {
      lines.push(`+${newLine}`);
    } else if (newLine === undefined) {
      lines.push(`-${oldLine}`);
    } else if (oldLine !== newLine) {
      lines.push(`-${oldLine}`);
      lines.push(`+${newLine}`);
    } else {
      lines.push(` ${newLine}`);
    }
  }
  
  return lines.join("\n");
}

/**
 * Check if a file exists and get its content
 */
async function getExistingContent(filePath: string): Promise<string | null> {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf-8");
    }
  } catch (e) {
    log.warn("Failed to read existing file", { filePath, error: e });
  }
  return null;
}

/**
 * Generate diff for a single file
 */
async function diffFile(
  scaffoldingFile: ScaffoldingFile,
  baseDir: string
): Promise<DiffResult> {
  const fullPath = path.join(baseDir, scaffoldingFile.path);
  const existingContent = await getExistingContent(fullPath);
  
  let status: DiffResult["status"];
  let diff: string;
  
  if (!existingContent) {
    // New file
    status = "added";
    diff = `--- /dev/null\n+++ b/${scaffoldingFile.path}\n@@ -0,0 +1,${scaffoldingFile.content.split("\n").length} @@\n${scaffoldingFile.content.split("\n").map(l => `+${l}`).join("\n")}`;
  } else if (scaffoldingFile.content === existingContent) {
    // No change
    status = "unchanged";
    diff = "No changes";
  } else {
    // Modified
    status = "modified";
    diff = generateUnifiedDiff(scaffoldingFile.path, existingContent, scaffoldingFile.content);
  }
  
  return {
    filePath: scaffoldingFile.path,
    status,
    diff,
    oldContent: existingContent || undefined,
    newContent: scaffoldingFile.content,
  };
}

/**
 * Generate a preview of all changes before applying
 */
export async function generatePreview(
  scaffoldingFiles: ScaffoldingFile[],
  baseDir: string
): Promise<PreviewResult> {
  log.info("Generating diff preview", { fileCount: scaffoldingFiles.length });
  
  const diffs: DiffResult[] = [];
  let totalAdded = 0;
  let totalModified = 0;
  let totalDeleted = 0;
  
  for (const file of scaffoldingFiles) {
    const diffResult = await diffFile(file, baseDir);
    diffs.push(diffResult);
    
    switch (diffResult.status) {
      case "added":
        totalAdded++;
        break;
      case "modified":
        totalModified++;
        break;
      case "deleted":
        totalDeleted++;
        break;
    }
  }
  
  const preview: PreviewResult = {
    diffs,
    totalAdded,
    totalModified,
    totalDeleted,
  };
  
  log.debug("Preview generated", {
    added: totalAdded,
    modified: totalModified,
    deleted: totalDeleted,
  });
  
  return preview;
}

/**
 * Format preview as human-readable string
 */
export function formatPreview(preview: PreviewResult): string {
  const lines: string[] = [];
  
  lines.push("## Code Changes Preview");
  lines.push("");
  lines.push(`- **Added**: ${preview.totalAdded} file(s)`);
  lines.push(`- **Modified**: ${preview.totalModified} file(s)`);
  lines.push(`- **Deleted**: ${preview.totalDeleted} file(s)`);
  lines.push("");
  lines.push("---");
  lines.push("");
  
  for (const diff of preview.diffs) {
    lines.push(`### ${diff.filePath} \`${diff.status}\``);
    lines.push("");
    
    if (diff.status === "unchanged") {
      lines.push("*No changes*");
    } else if (diff.status === "added") {
      lines.push("```typescript");
      lines.push(diff.newContent || "");
      lines.push("```");
    } else {
      lines.push("```diff");
      lines.push(diff.diff);
      lines.push("```");
    }
    lines.push("");
  }
  
  return lines.join("\n");
}

/**
 * Check if there are any actual changes to apply
 */
export function hasChanges(preview: PreviewResult): boolean {
  return preview.totalAdded > 0 || 
         preview.totalModified > 0 || 
         preview.totalDeleted > 0;
}
