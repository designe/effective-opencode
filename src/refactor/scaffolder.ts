import type { ScaffoldingFile, ScaffoldingResult } from "./types";
import { createContextLogger } from "../logger";

const log = createContextLogger("scaffolder");

/**
 * Parse design specification and extract file structure
 */
export function parseFileStructure(design: string): {
  files: Array<{ path: string; description: string }>;
} {
  const files: Array<{ path: string; description: string }> = [];
  
  // Look for file structure patterns like:
  // - src/services/auth.ts
  // - `src/services/auth.ts` - Authentication service
  // - File: src/services/auth.ts (description)
  
  const patterns = [
    // Backtick quoted: `src/services/auth.ts`
    /`([^`]+\.[tj]s)`/g,
    // Markdown file: src/services/auth.ts
    /(?:^|\n)\s*[-*]\s+`?([^\n`]+(?:\.[tj]s|json|yaml|md))`?/gm,
    // File: path - description
    /File:\s*([^\s]+(?:\.[tj]s|json|yaml|md))\s*[-–—]\s*(.+)/g,
    // Path followed by description on next line
    /(?:^|\n)([a-zA-Z0-9/_.-]+\.[tj]s)\n\s*[-–—]?\s*(.+)/gm,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(design)) !== null) {
      const path = match[1].trim();
      const description = match[2]?.trim() || "";
      
      // Avoid duplicates
      if (!files.some(f => f.path === path)) {
        files.push({ path, description });
      }
    }
  }

  log.debug("Parsed file structure", { count: files.length });
  return { files };
}

/**
 * Detect language from file extension
 */
function detectLanguage(filePath: string): ScaffoldingFile["language"] {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "json":
      return "json";
    case "yaml":
    case "yml":
      return "yaml";
    case "md":
      return "markdown";
    default:
      return "text";
  }
}

/**
 * Generate TypeScript scaffolding content based on design
 */
function generateTypeScriptContent(filePath: string, design: string): string {
  const fileName = filePath.split("/").pop()?.replace(".ts", "") || "module";
  const className = fileName
    .split(/[-_]/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

  // Check what type of file this is based on content in design
  const isService = /service|handler|controller/i.test(design);
  const isType = /type|interface|enum|struct/i.test(design) && !isService;
  const isUtility = /util|helper|function/i.test(design);
  const isModel = /model|entity|schema/i.test(design);

  if (isType) {
    return `// Type definitions for ${fileName}

export interface ${className} {
  // TODO: Define properties based on design
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

export type ${className}List = ${className}[];

export interface Create${className}Input {
  // TODO: Add creation fields
}

export interface Update${className}Input {
  // TODO: Add update fields
}
`;
  }

  if (isService) {
    return `// Service for ${fileName}

import type { ${className}, Create${className}Input, Update${className}Input } from '../types/${fileName}';

export class ${className}Service {
  async findAll(): Promise<${className}List> {
    // TODO: Implement findAll
    return [];
  }

  async findById(id: string): Promise<${className} | null> {
    // TODO: Implement findById
    return null;
  }

  async create(input: Create${className}Input): Promise<${className}> {
    // TODO: Implement create
    throw new Error('Not implemented');
  }

  async update(id: string, input: Update${className}Input): Promise<${className}> {
    // TODO: Implement update
    throw new Error('Not implemented');
  }

  async delete(id: string): Promise<boolean> {
    // TODO: Implement delete
    throw new Error('Not implemented');
  }
}

export const ${fileName}Service = new ${className}Service();
`;
  }

  if (isUtility) {
    return `// Utility functions for ${fileName}

export function ${fileName}(...args: unknown[]): unknown {
  // TODO: Implement
  throw new Error('Not implemented');
}

export async function ${fileName}Async(...args: unknown[]): Promise<unknown> {
  // TODO: Implement async version
  throw new Error('Not implemented');
}
`;
  }

  if (isModel) {
    return `// Model for ${fileName}

export interface ${className} {
  id: string;
  // TODO: Add model fields
}

export function validate${className}(data: unknown): data is ${className} {
  // TODO: Implement validation
  return typeof data === 'object' && data !== null;
}
`;
  }

  // Default generic TypeScript
  return `// ${fileName} - Generated from design

export class ${className} {
  // TODO: Implement class
}

export default ${className};
`;
}

/**
 * Generate JSON scaffolding
 */
function generateJSONContent(filePath: string): string {
  const fileName = filePath.split("/").pop()?.replace(".json", "") || "config";
  
  if (fileName === "package") {
    return JSON.stringify({
      "name": "generated-package",
      "version": "1.0.0",
      "description": "Generated from architect design",
      "main": "dist/index.js",
      "scripts": {
        "build": "tsc",
        "test": "jest"
      }
    }, null, 2);
  }

  if (fileName === "config") {
    return JSON.stringify({
      "name": "generated-config",
      "settings": {}
    }, null, 2);
  }

  return JSON.stringify({}, null, 2);
}

/**
 * Generate Markdown scaffolding
 */
function generateMarkdownContent(filePath: string, description: string): string {
  const fileName = filePath.split("/").pop()?.replace(".md", "") || "document";
  
  return `# ${fileName}

${description || "Generated from architect design"}

## Overview

<!-- TODO: Add overview -->

## Usage

<!-- TODO: Add usage examples -->

## API

<!-- TODO: Add API documentation -->
`;
}

/**
 * Generate scaffolding content based on file type
 */
function generateContent(
  filePath: string,
  design: string,
  language: ScaffoldingFile["language"]
): string {
  switch (language) {
    case "typescript":
      return generateTypeScriptContent(filePath, design);
    case "javascript":
      return generateTypeScriptContent(filePath, design).replace(
        /: string|: number|: boolean|: void/g,
        ""
      );
    case "json":
      return generateJSONContent(filePath);
    case "markdown":
      return generateMarkdownContent(filePath, design);
    default:
      return `// Generated from design: ${filePath}\n// TODO: Implement`;
  }
}

/**
 * Main scaffolding generator
 * Parses design specification and generates file scaffolding
 */
export function generateScaffolding(
  design: string,
  baseDir: string = "src"
): ScaffoldingResult {
  log.info("Generating scaffolding from design");

  const { files } = parseFileStructure(design);
  
  if (files.length === 0) {
    log.warn("No files found in design, generating default structure");
    files.push({ path: `${baseDir}/index.ts`, description: "Main entry point" });
  }

  const scaffoldingFiles: ScaffoldingFile[] = files.map(({ path, description }) => {
    const fullPath = path.startsWith(baseDir) ? path : `${baseDir}/${path}`;
    const language = detectLanguage(fullPath);
    
    return {
      path: fullPath,
      content: generateContent(fullPath, description || design, language),
      language,
    };
  });

  const summary = `Generated ${scaffoldingFiles.length} file(s) from design`;

  log.info("Scaffolding generated", { fileCount: scaffoldingFiles.length });

  return {
    files: scaffoldingFiles,
    changes: [],
    summary,
  };
}
