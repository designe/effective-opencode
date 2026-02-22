import * as fs from "fs";
import * as path from "path";
import { generateScaffolding } from "./scaffolder";
import { generatePreview, formatPreview, hasChanges } from "./differ";
import { generateTestScaffolding, detectTestFramework, type TestFramework } from "./test-generator";
import { RollbackManager } from "./rollback";
import type {
  ScaffoldingResult,
  PreviewResult,
  RollbackCheckpoint,
  RollbackResult,
  RefactorOptions,
} from "./types";
import { createContextLogger } from "../logger";

const log = createContextLogger("refactor");

/**
 * Default refactoring options
 */
const DEFAULT_OPTIONS: RefactorOptions = {
  baseDir: "src",
  autoApply: false,
  createBackup: true,
  maxFiles: 50,
};

/**
 * Main refactoring engine
 * Orchestrates scaffolding, preview, and rollback
 */
export class RefactorEngine {
  private workspaceRoot: string;
  private options: RefactorOptions;
  private rollbackManager: RollbackManager;
  private lastPreview: PreviewResult | null = null;

  constructor(workspaceRoot: string, options: Partial<RefactorOptions> = {}) {
    this.workspaceRoot = workspaceRoot;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.rollbackManager = new RollbackManager(workspaceRoot);
    log.info("RefactorEngine initialized", { workspaceRoot, options: this.options });
  }

  /**
   * Generate scaffolding from design specification
   */
  generate(design: string): ScaffoldingResult {
    log.info("Generating scaffolding from design");
    const result = generateScaffolding(design, this.options.baseDir);
    log.debug("Scaffolding generated", { fileCount: result.files.length });
    return result;
  }

  /**
   * Preview changes before applying
   */
  async preview(scaffolding: ScaffoldingResult): Promise<PreviewResult> {
    log.info("Generating preview");
    const preview = await generatePreview(scaffolding.files, this.workspaceRoot);
    this.lastPreview = preview;
    return preview;
  }

  /**
   * Format preview as markdown
   */
  formatPreviewAsMarkdown(preview: PreviewResult): string {
    return formatPreview(preview);
  }

  /**
   * Check if there are changes to apply
   */
  hasChanges(preview?: PreviewResult): boolean {
    return hasChanges(preview || this.lastPreview!);
  }

  /**
   * Apply the generated scaffolding
   */
  async apply(
    scaffolding: ScaffoldingResult,
    description: string = "Auto-generated from design"
  ): Promise<{
    success: boolean;
    appliedFiles: string[];
    checkpointId?: string;
    errors: string[];
  }> {
    log.info("Applying scaffolding");

    // Ensure we have a preview
    if (!this.lastPreview) {
      await this.preview(scaffolding);
    }

    // Create checkpoint if backup is enabled
    let checkpointId: string | undefined;
    if (this.options.createBackup) {
      const filesToBackup = scaffolding.files.map(f => ({
        path: path.join(this.workspaceRoot, f.path),
        content: fs.existsSync(path.join(this.workspaceRoot, f.path))
          ? fs.readFileSync(path.join(this.workspaceRoot, f.path), "utf-8")
          : "",
      }));
      const checkpoint = await this.rollbackManager.createCheckpoint(
        description,
        filesToBackup
      );
      checkpointId = checkpoint.id;
    }

    const appliedFiles: string[] = [];
    const errors: string[] = [];

    for (const file of scaffolding.files) {
      try {
        const fullPath = path.join(this.workspaceRoot, file.path);
        const dir = path.dirname(fullPath);

        // Ensure directory exists
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        // Write file
        fs.writeFileSync(fullPath, file.content);
        appliedFiles.push(file.path);
        
        log.debug("File created", { path: file.path });
      } catch (e) {
        const errorMsg = `Failed to create ${file.path}: ${e}`;
        errors.push(errorMsg);
        log.error("Failed to create file", { path: file.path, error: e });
      }
    }

    const success = errors.length === 0;
    log.info("Scaffolding applied", { 
      success, 
      applied: appliedFiles.length, 
      errors: errors.length 
    });

    return {
      success,
      appliedFiles,
      checkpointId,
      errors,
    };
  }

  /**
   * Rollback to a previous checkpoint
   */
  async rollback(checkpointId: string): Promise<RollbackResult> {
    log.info("Rolling back", { checkpointId });
    return this.rollbackManager.restoreCheckpoint(checkpointId);
  }

  /**
   * Quick rollback to the last checkpoint
   */
  async quickRollback(): Promise<RollbackResult> {
    const checkpoints = this.rollbackManager.listCheckpoints();
    if (checkpoints.length === 0) {
      return {
        success: false,
        checkpointId: "",
        restoredFiles: [],
        errors: ["No checkpoints available"],
      };
    }
    return this.rollbackManager.restoreCheckpoint(checkpoints[0].id);
  }

  /**
   * List available checkpoints
   */
  listCheckpoints(): RollbackCheckpoint[] {
    return this.rollbackManager.listCheckpoints();
  }

  /**
   * Delete a checkpoint
   */
  deleteCheckpoint(checkpointId: string): boolean {
    return this.rollbackManager.deleteCheckpoint(checkpointId);
  }

  /**
   * Get the last preview result
   */
  getLastPreview(): PreviewResult | null {
    return this.lastPreview;
  }

  /**
   * Generate test scaffolding for the generated code
   */
  generateTests(
    scaffolding?: ScaffoldingResult,
    framework?: TestFramework
  ): Array<{ path: string; content: string }> {
    const files = scaffolding?.files || [];
    const sourceFiles = files
      .filter(f => f.language === "typescript" || f.language === "javascript")
      .map(f => ({ path: f.path, content: f.content }));

    const tests = generateTestScaffolding(
      sourceFiles,
      this.workspaceRoot,
      this.options.baseDir,
      framework
    );

    log.info("Test scaffolding generated", { testCount: tests.length });
    return tests.map(t => ({ path: t.path, content: t.content }));
  }

  /**
   * Apply generated test files
   */
  async applyTests(
    tests: Array<{ path: string; content: string }>,
    description: string = "Auto-generated tests"
  ): Promise<{
    success: boolean;
    appliedFiles: string[];
    errors: string[];
  }> {
    log.info("Applying test scaffolding");

    const appliedFiles: string[] = [];
    const errors: string[] = [];

    for (const file of tests) {
      try {
        const fullPath = path.join(this.workspaceRoot, file.path);
        const dir = path.dirname(fullPath);

        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        if (!fs.existsSync(fullPath)) {
          fs.writeFileSync(fullPath, file.content);
          appliedFiles.push(file.path);
          log.debug("Test file created", { path: file.path });
        } else {
          log.debug("Test file already exists, skipping", { path: file.path });
        }
      } catch (e) {
        const errorMsg = `Failed to create test ${file.path}: ${e}`;
        errors.push(errorMsg);
        log.error("Failed to create test file", { path: file.path, error: e });
      }
    }

    return {
      success: errors.length === 0,
      appliedFiles,
      errors,
    };
  }
}

/**
 * Convenience function to run full refactor flow
 */
export async function runRefactor(
  workspaceRoot: string,
  design: string,
  options: Partial<RefactorOptions> = {}
): Promise<{
  scaffolding: ScaffoldingResult;
  preview: PreviewResult;
  apply: (autoApply?: boolean) => Promise<{
    success: boolean;
    appliedFiles: string[];
    checkpointId?: string;
    errors: string[];
  }>;
  rollback: () => Promise<RollbackResult>;
}> {
  const engine = new RefactorEngine(workspaceRoot, options);

  // Generate scaffolding
  const scaffolding = engine.generate(design);

  // Generate preview
  const preview = await engine.preview(scaffolding);

  return {
    scaffolding,
    preview,
    apply: (autoApply = false) => {
      if (!autoApply) {
        log.info("Auto-apply disabled, use apply() to commit changes");
        return Promise.resolve({
          success: false,
          appliedFiles: [],
          errors: ["Preview only - call apply() to commit"],
        });
      }
      return engine.apply(scaffolding);
    },
    rollback: () => engine.quickRollback(),
  };
}
