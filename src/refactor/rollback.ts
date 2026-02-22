import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import type { RollbackCheckpoint, RollbackResult } from "./types";
import { createContextLogger } from "../logger";

const log = createContextLogger("rollback");

/**
 * Rollback manager - handles creating checkpoints and restoring files
 */
export class RollbackManager {
  private checkpointsDir: string;
  private checkpoints: Map<string, RollbackCheckpoint> = new Map();

  constructor(workspaceRoot: string) {
    this.checkpointsDir = path.join(workspaceRoot, ".opencode", "refactor-checkpoints");
    this.ensureDirectory();
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(this.checkpointsDir)) {
      fs.mkdirSync(this.checkpointsDir, { recursive: true });
    }
  }

  /**
   * Create a checkpoint before applying changes
   */
  async createCheckpoint(
    description: string,
    files: Array<{ path: string; content: string }>
  ): Promise<RollbackCheckpoint> {
    const checkpoint: RollbackCheckpoint = {
      id: randomUUID(),
      timestamp: Date.now(),
      description,
      files: files.map(f => ({
        path: f.path,
        content: f.content,
      })),
    };

    // Save to disk
    const checkpointPath = path.join(this.checkpointsDir, `${checkpoint.id}.json`);
    fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));

    // Keep in memory
    this.checkpoints.set(checkpoint.id, checkpoint);

    log.info("Checkpoint created", { 
      id: checkpoint.id, 
      description, 
      fileCount: files.length 
    });

    return checkpoint;
  }

  /**
   * Restore files from a checkpoint
   */
  async restoreCheckpoint(checkpointId: string): Promise<RollbackResult> {
    let checkpoint: RollbackCheckpoint | undefined;

    // Check memory first
    checkpoint = this.checkpoints.get(checkpointId);

    // Load from disk if not in memory
    if (!checkpoint) {
      const checkpointPath = path.join(this.checkpointsDir, `${checkpointId}.json`);
      if (fs.existsSync(checkpointPath)) {
        try {
          checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf-8"));
        } catch (e) {
          log.error("Failed to load checkpoint", { checkpointId, error: e });
        }
      }
    }

    if (!checkpoint) {
      return {
        success: false,
        checkpointId,
        restoredFiles: [],
        errors: [`Checkpoint not found: ${checkpointId}`],
      };
    }

    const restoredFiles: string[] = [];
    const errors: string[] = [];

    for (const file of checkpoint.files) {
      try {
        const fullPath = file.path;
        const dir = path.dirname(fullPath);

        // Ensure directory exists
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        // Restore file content
        fs.writeFileSync(fullPath, file.content);
        restoredFiles.push(fullPath);
        
        log.debug("File restored", { path: fullPath });
      } catch (e) {
        const errorMsg = `Failed to restore ${file.path}: ${e}`;
        errors.push(errorMsg);
        log.error("Failed to restore file", { path: file.path, error: e });
      }
    }

    log.info("Checkpoint restored", { 
      checkpointId, 
      restored: restoredFiles.length,
      errors: errors.length 
    });

    return {
      success: errors.length === 0,
      checkpointId,
      restoredFiles,
      errors,
    };
  }

  /**
   * List all available checkpoints
   */
  listCheckpoints(): RollbackCheckpoint[] {
    const checkpoints: RollbackCheckpoint[] = [];

    try {
      const files = fs.readdirSync(this.checkpointsDir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          try {
            const content = fs.readFileSync(
              path.join(this.checkpointsDir, file),
              "utf-8"
            );
            checkpoints.push(JSON.parse(content));
          } catch (e) {
            log.warn("Failed to read checkpoint file", { file });
          }
        }
      }
    } catch (e) {
      log.error("Failed to list checkpoints", { error: e });
    }

    // Sort by timestamp descending
    return checkpoints.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Delete a checkpoint
   */
  deleteCheckpoint(checkpointId: string): boolean {
    const checkpointPath = path.join(this.checkpointsDir, `${checkpointId}.json`);
    
    try {
      if (fs.existsSync(checkpointPath)) {
        fs.unlinkSync(checkpointPath);
        this.checkpoints.delete(checkpointId);
        log.info("Checkpoint deleted", { checkpointId });
        return true;
      }
    } catch (e) {
      log.error("Failed to delete checkpoint", { checkpointId, error: e });
    }
    
    return false;
  }

  /**
   * Clean up old checkpoints (older than specified hours)
   */
  cleanupOldCheckpoints(hoursOld: number = 24): number {
    const cutoff = Date.now() - hoursOld * 60 * 60 * 1000;
    let deleted = 0;

    try {
      const files = fs.readdirSync(this.checkpointsDir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          const filePath = path.join(this.checkpointsDir, file);
          const stat = fs.statSync(filePath);
          
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(filePath);
            deleted++;
          }
        }
      }
    } catch (e) {
      log.error("Failed to cleanup old checkpoints", { error: e });
    }

    log.info("Cleaned up old checkpoints", { deleted, hoursOld });
    return deleted;
  }
}

/**
 * Quick rollback helper - restore files that were created/modified
 */
export async function quickRollback(
  workspaceRoot: string,
  files: string[]
): Promise<RollbackResult> {
  const manager = new RollbackManager(workspaceRoot);
  const checkpoints = manager.listCheckpoints();

  if (checkpoints.length === 0) {
    return {
      success: false,
      checkpointId: "",
      restoredFiles: [],
      errors: ["No checkpoints available"],
    };
  }

  // Use the most recent checkpoint
  const latestCheckpoint = checkpoints[0];
  return manager.restoreCheckpoint(latestCheckpoint.id);
}
