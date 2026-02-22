// ============================================================================
// Refactoring Module Types
// ============================================================================

/**
 * Represents a file to be created during scaffolding
 */
export interface ScaffoldingFile {
  path: string;
  content: string;
  language: "typescript" | "javascript" | "json" | "yaml" | "markdown" | "text";
}

/**
 * Represents a change to an existing file
 */
export interface FileChange {
  path: string;
  type: "create" | "modify" | "delete";
  content?: string;
  oldContent?: string;
}

/**
 * Result of scaffolding generation
 */
export interface ScaffoldingResult {
  files: ScaffoldingFile[];
  changes: FileChange[];
  summary: string;
}

/**
 * Diff result for preview
 */
export interface DiffResult {
  filePath: string;
  status: "added" | "modified" | "deleted" | "unchanged";
  diff: string;
  oldContent?: string;
  newContent?: string;
}

/**
 * Preview result before applying changes
 */
export interface PreviewResult {
  diffs: DiffResult[];
  totalAdded: number;
  totalModified: number;
  totalDeleted: number;
}

/**
 * Rollback checkpoint
 */
export interface RollbackCheckpoint {
  id: string;
  timestamp: number;
  description: string;
  files: {
    path: string;
    content: string;
    originalContent?: string;
  }[];
}

/**
 * Rollback result
 */
export interface RollbackResult {
  success: boolean;
  checkpointId: string;
  restoredFiles: string[];
  errors: string[];
}

/**
 * Refactoring options
 */
export interface RefactorOptions {
  /** Base directory for scaffolding */
  baseDir: string;
  /** Whether to automatically apply changes after preview */
  autoApply: boolean;
  /** Whether to create backup before changes */
  createBackup: boolean;
  /** Maximum files to process */
  maxFiles?: number;
}
