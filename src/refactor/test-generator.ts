/**
 * Test Scaffolding Generator
 * 
 * Automatically generates test files based on the generated code.
 * Supports Jest, Vitest, and other testing frameworks.
 */

import * as path from 'path';
import { createContextLogger } from '../logger';

const log = createContextLogger('test-generator');

export type TestFramework = 'jest' | 'vitest' | 'bun' | 'node';

export interface TestSpec {
  path: string;
  content: string;
  framework: TestFramework;
}

/**
 * Detect test framework from project configuration
 */
export function detectTestFramework(workspaceRoot: string): TestFramework {
  const packageJsonPath = path.join(workspaceRoot, 'package.json');
  
  try {
    const packageJson = require(packageJsonPath);
    
    if (packageJson.devDependencies?.vitest || packageJson.dependencies?.vitest) {
      return 'vitest';
    }
    if (packageJson.devDependencies?.bun || packageJson.dependencies?.bun) {
      return 'bun';
    }
    if (packageJson.devDependencies?.jest || packageJson.dependencies?.jest) {
      return 'jest';
    }
  } catch {
    // Ignore errors
  }
  
  // Default to vitest as it's the modern choice
  return 'vitest';
}

/**
 * Generate test file path for a source file
 */
function getTestFilePath(sourceFilePath: string, baseDir: string): string {
  const fileName = path.basename(sourceFilePath);
  const dir = path.dirname(sourceFilePath);
  
  // Convert src/file.ts -> src/__tests__/file.test.ts
  const testDir = dir.includes(baseDir) 
    ? dir.replace(baseDir, `${baseDir}/__tests__`)
    : `${baseDir}/__tests__`;
  
  const ext = path.extname(fileName);
  const baseName = path.basename(fileName, ext);
  
  return `${testDir}/${baseName}.test${ext}`;
}

/**
 * Parse TypeScript/JavaScript source to extract exports for testing
 */
function parseExports(content: string): {
  classes: string[];
  functions: string[];
  interfaces: string[];
  types: string[];
} {
  const classes: string[] = [];
  const functions: string[] = [];
  const interfaces: string[] = [];
  const types: string[] = [];
  
  // Extract class declarations
  const classMatches = content.matchAll(/(?:export\s+)?class\s+(\w+)/g);
  for (const match of classMatches) {
    classes.push(match[1]);
  }
  
  // Extract function declarations
  const funcMatches = content.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/g);
  for (const match of funcMatches) {
    functions.push(match[1]);
  }
  
  // Extract interface declarations
  const interfaceMatches = content.matchAll(/(?:export\s+)?interface\s+(\w+)/g);
  for (const match of interfaceMatches) {
    interfaces.push(match[1]);
  }
  
  // Extract type declarations
  const typeMatches = content.matchAll(/(?:export\s+)?type\s+(\w+)/g);
  for (const match of typeMatches) {
    types.push(match[1]);
  }
  
  return { classes, functions, interfaces, types };
}

/**
 * Generate Jest test template
 */
function generateJestTest(
  filePath: string,
  exports: ReturnType<typeof parseExports>
): string {
  const fileName = path.basename(filePath, '.ts');
  const importPath = `./${path.basename(filePath, '.ts')}`;
  
  const lines: string[] = [];
  lines.push(`import { ${[...exports.classes, ...exports.functions].join(', ')} } from '${importPath}';`);
  lines.push('');
  
  // Add describe blocks for classes
  for (const cls of exports.classes) {
    lines.push(`describe('${cls}', () => {`);
    lines.push(`  it('should be defined', () => {`);
    lines.push(`    expect(${cls}).toBeDefined();`);
    lines.push(`  });`);
    lines.push('');
    lines.push(`  it('should have required methods', () => {`);
    lines.push(`    // TODO: Add specific tests`);
    lines.push(`  });`);
    lines.push(`});`);
    lines.push('');
  }
  
  // Add describe blocks for functions
  for (const func of exports.functions) {
    lines.push(`describe('${func}', () => {`);
    lines.push(`  it('should be defined', () => {`);
    lines.push(`    expect(${func}).toBeDefined();`);
    lines.push(`  });`);
    lines.push('');
    lines.push(`  it('should return expected result', async () => {`);
    lines.push(`    // TODO: Add test case`);
    lines.push(`    const result = await ${func}();`);
    lines.push(`    expect(result).toBeDefined();`);
    lines.push(`  });`);
    lines.push(`});`);
    lines.push('');
  }
  
  // Add interface tests if any
  for (const iface of exports.interfaces) {
    lines.push(`describe('${iface} type', () => {`);
    lines.push(`  it('should validate correctly', () => {`);
    lines.push(`    // TODO: Add type validation tests`);
    lines.push(`  });`);
    lines.push(`});`);
    lines.push('');
  }
  
  return lines.join('\n');
}

/**
 * Generate Vitest test template
 */
function generateVitestTest(
  filePath: string,
  exports: ReturnType<typeof parseExports>
): string {
  const fileName = path.basename(filePath, '.ts');
  const importPath = `./${path.basename(filePath, '.ts')}`;
  
  const lines: string[] = [];
  lines.push(`import { describe, it, expect } from 'vitest';`);
  lines.push(`import { ${[...exports.classes, ...exports.functions].join(', ')} } from '${importPath}';`);
  lines.push('');
  
  // Add describe blocks for classes
  for (const cls of exports.classes) {
    lines.push(`describe('${cls}', () => {`);
    lines.push(`  it('should be defined', () => {`);
    lines.push(`    expect(${cls}).toBeDefined();`);
    lines.push(`  });`);
    lines.push('');
    lines.push(`  it('should instantiate correctly', () => {`);
    lines.push(`    // TODO: Add specific tests`);
    lines.push(`  });`);
    lines.push(`});`);
    lines.push('');
  }
  
  // Add describe blocks for functions
  for (const func of exports.functions) {
    lines.push(`describe('${func}', () => {`);
    lines.push(`  it('should be defined', () => {`);
    lines.push(`    expect(${func}).toBeDefined();`);
    lines.push(`  });`);
    lines.push('');
    lines.push(`  it('should return expected result', async () => {`);
    lines.push(`    // TODO: Add test case`);
    lines.push(`    const result = await ${func}();`);
    lines.push(`    expect(result).toBeDefined();`);
    lines.push(`  });`);
    lines.push(`});`);
    lines.push('');
  }
  
  // Add interface tests if any
  for (const iface of exports.interfaces) {
    lines.push(`describe('${iface} type', () => {`);
    lines.push(`  it('should validate correctly', () => {`);
    lines.push(`    // TODO: Add type validation tests`);
    lines.push(`  });`);
    lines.push(`});`);
    lines.push('');
  }
  
  return lines.join('\n');
}

/**
 * Generate Bun test template
 */
function generateBunTest(
  filePath: string,
  exports: ReturnType<typeof parseExports>
): string {
  const fileName = path.basename(filePath, '.ts');
  const importPath = `./${path.basename(filePath, '.ts')}`;
  
  const lines: string[] = [];
  lines.push(`import { describe, expect, test } from 'bun:test';`);
  lines.push(`import { ${[...exports.classes, ...exports.functions].join(', ')} } from '${importPath}';`);
  lines.push('');
  
  // Add describe blocks for classes
  for (const cls of exports.classes) {
    lines.push(`describe('${cls}', () => {`);
    lines.push(`  test('should be defined', () => {`);
    lines.push(`    expect(${cls}).toBeDefined();`);
    lines.push(`  });`);
    lines.push(`});`);
    lines.push('');
  }
  
  // Add describe blocks for functions
  for (const func of exports.functions) {
    lines.push(`describe('${func}', () => {`);
    lines.push(`  test('should be defined', () => {`);
    lines.push(`    expect(${func}).toBeDefined();`);
    lines.push(`  });`);
    lines.push('');
    lines.push(`  test('should return expected result', async () => {`);
    lines.push(`    // TODO: Add test case`);
    lines.push(`    const result = await ${func}();`);
    lines.push(`    expect(result).toBeDefined();`);
    lines.push(`  });`);
    lines.push(`});`);
    lines.push('');
  }
  
  return lines.join('\n');
}

/**
 * Generate test file based on source file
 */
function generateTestForFile(
  sourceFilePath: string,
  content: string,
  framework: TestFramework,
  baseDir: string
): TestSpec | null {
  const exports = parseExports(content);
  
  // Skip if no exports found
  if (exports.classes.length === 0 && exports.functions.length === 0 && 
      exports.interfaces.length === 0 && exports.types.length === 0) {
    log.debug('No exports found, skipping test generation', { path: sourceFilePath });
    return null;
  }
  
  const testPath = getTestFilePath(sourceFilePath, baseDir);
  let testContent: string;
  
  switch (framework) {
    case 'jest':
      testContent = generateJestTest(sourceFilePath, exports);
      break;
    case 'vitest':
      testContent = generateVitestTest(sourceFilePath, exports);
      break;
    case 'bun':
      testContent = generateBunTest(sourceFilePath, exports);
      break;
    default:
      testContent = generateVitestTest(sourceFilePath, exports);
  }
  
  return {
    path: testPath,
    content: testContent,
    framework
  };
}

/**
 * Generate test files for all source files
 */
export function generateTestScaffolding(
  sourceFiles: Array<{ path: string; content: string }>,
  workspaceRoot: string,
  baseDir: string = 'src',
  framework?: TestFramework
): TestSpec[] {
  const testFramework = framework || detectTestFramework(workspaceRoot);
  const tests: TestSpec[] = [];
  
  log.info('Generating test scaffolding', { 
    fileCount: sourceFiles.length, 
    framework: testFramework 
  });
  
  for (const file of sourceFiles) {
    // Skip non-source files
    if (!file.path.endsWith('.ts') && !file.path.endsWith('.js')) {
      continue;
    }
    
    // Skip test files themselves
    if (file.path.includes('.test.') || file.path.includes('.spec.')) {
      continue;
    }
    
    const testSpec = generateTestForFile(file.path, file.content, testFramework, baseDir);
    if (testSpec) {
      tests.push(testSpec);
      log.debug('Generated test', { 
        source: file.path, 
        test: testSpec.path 
      });
    }
  }
  
  log.info('Test scaffolding generated', { testCount: tests.length });
  return tests;
}

/**
 * Generate a simple test file template
 */
export function generateSimpleTest(
  name: string,
  framework: TestFramework = 'vitest'
): string {
  switch (framework) {
    case 'jest':
      return `describe('${name}', () => {
  it('should pass', () => {
    expect(true).toBe(true);
  });
});`;
    
    case 'vitest':
      return `import { describe, it, expect } from 'vitest';

describe('${name}', () => {
  it('should pass', () => {
    expect(true).toBe(true);
  });
});`;
    
    case 'bun':
      return `import { describe, expect, test } from 'bun:test';

describe('${name}', () => {
  test('should pass', () => {
    expect(true).toBe(true);
  });
});`;
    
    default:
      return `// Test for ${name}\n// TODO: Implement tests`;
  }
}
