import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  detectTestFramework,
  generateTestScaffolding,
} from "../refactor/test-generator";

describe("test-generator", () => {
  const createWorkspace = () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "og-test-gen-"));
    return workspaceRoot;
  };

  test("generates valid import syntax for function scaffolding", () => {
    const workspaceRoot = createWorkspace();
    try {
      const sourceFiles = [
        {
          path: "src/math.ts",
          content: "export function add(a: number, b: number) { return a + b; }",
        },
      ];

      const tests = generateTestScaffolding(sourceFiles, workspaceRoot, "src", "jest");

      expect(tests).toHaveLength(1);
      expect(tests[0].path).toBe("src/__tests__/math.test.ts");
      expect(tests[0].content).toContain("import { add } from './math';");
      expect(tests[0].content).not.toContain("} } from './math';");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("omits module imports for type-only exports", () => {
    const workspaceRoot = createWorkspace();
    try {
      const sourceFiles = [
        {
          path: "src/types.ts",
          content: "export interface User { id: string; }",
        },
      ];

      const tests = generateTestScaffolding(sourceFiles, workspaceRoot, "src", "vitest");

      expect(tests).toHaveLength(1);
      expect(tests[0].content).toContain("describe('User type', () => {");
      expect(tests[0].content).not.toContain("import { User } from './types';");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("detects framework from package.json priority", () => {
    const workspaceRoot = createWorkspace();
    try {
      const packageJsonPath = join(workspaceRoot, "package.json");
      writeFileSync(
        packageJsonPath,
        JSON.stringify({
          devDependencies: {
            vitest: "1.0.0",
            bun: "1.0.0",
            jest: "29.0.0",
          },
        }),
      );

      const detected = detectTestFramework(workspaceRoot);

      expect(detected).toBe("vitest");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
