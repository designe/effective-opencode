import { parseBashCommand } from "../security/command-parser";

export interface MutationDecision {
  mutate: boolean;
  reason: string;
}

interface NormalizedToolEvent {
  tool?: string;
  args?: Record<string, unknown>;
}

const MUTATING_TOOLS = new Set([
  "write",
  "edit",
  "apply_patch",
  "delete",
  "mkdir",
  "rmdir",
  "mv",
  "cp",
  "rename",
  "move",
  "touch",
  "rm",
  "patch",
  "create",
]);

const READ_ONLY_TOOLS = new Set([
  "read",
  "glob",
  "search",
  "find",
  "list",
  "read_file",
  "stat",
  "ls",
]);

const MUTATING_SHELL_COMMANDS = new Set([
  "rm",
  "rmdir",
  "mkdir",
  "touch",
  "mv",
  "cp",
  "chmod",
  "chown",
  "chgrp",
  "install",
  "curl",
  "wget",
  "tee",
  "truncate",
  "truncatef",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "python",
  "node",
  "git",
]);

const READ_ONLY_SHELL_COMMANDS = new Set([
  "cat",
  "ls",
  "pwd",
  "which",
  "whoami",
  "echo",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "grep",
  "sed",
  "awk",
  "printf",
  "date",
  "git",
]);

const MUTATING_GIT_COMMANDS = new Set([
  "add",
  "rm",
  "mv",
  "commit",
  "push",
  "pull",
  "checkout",
  "switch",
  "merge",
  "rebase",
  "reset",
  "restore",
  "branch",
  "tag",
  "clone",
  "fetch",
]);

function normalizeToolEvent(event: unknown): NormalizedToolEvent | null {
  if (!event || typeof event !== "object") return null;

  const cast = event as Record<string, unknown>;
  const payloadCandidate =
    cast.type === "tool.execute.before" || cast.type === "tool.execute.after"
      ? cast.payload
      : null;

  const source =
    payloadCandidate && typeof payloadCandidate === "object" && !Array.isArray(payloadCandidate)
      ? (payloadCandidate as Record<string, unknown>)
      : cast;

  const payloadTool = source?.tool;
  const payloadArgs = source?.args;

  if (typeof payloadTool !== "string" || !payloadTool) return null;

  return {
    tool: payloadTool,
    args:
      payloadArgs && typeof payloadArgs === "object" && !Array.isArray(payloadArgs)
        ? (payloadArgs as Record<string, unknown>)
        : undefined,
  };
}

function hasRedirectToken(tokens: string[]): boolean {
  return tokens.some((token) => {
    if (token === ">" || token === ">>" || token === "2>" || token === "2>>") {
      return true;
    }

    return token.startsWith(">") || token.includes(">>") || token.includes("2>");
  });
}

function extractShellScriptArg(args: string[]): string | undefined {
  if (args.length === 0) return undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--") {
      return args[i + 1];
    }

    if (arg === "-c" || arg === "-lc" || arg === "-ic" || arg === "--command") {
      return args[i + 1];
    }

    if (arg.startsWith("-lc") && arg.length > 3) {
      return args[i + 1] ?? arg.slice(3);
    }

    if (arg.startsWith("-ic") && arg.length > 3) {
      return args[i + 1] ?? arg.slice(3);
    }

    if (arg.startsWith("-") && !arg.includes("c")) {
      continue;
    }

    return arg;
  }

  return undefined;
}

function classifyBashMutation(rawCommand: string): MutationDecision {
  const tokens = parseBashCommand(rawCommand);
  if (!tokens || !tokens.command) {
    return {
      mutate: true,
      reason: "unparseable-bash-command",
    };
  }

  const script = extractShellScriptArg(tokens.args);
  if (!script) {
    return {
      mutate: true,
      reason: "bash-no-script",
    };
  }

  const scriptTokens = parseBashCommand(script);
  if (!scriptTokens || !scriptTokens.command) {
    return {
      mutate: true,
      reason: "unparseable-shell-script",
    };
  }

  const command = scriptTokens.command;
  const scriptArgs = scriptTokens.args;

  if (hasRedirectToken(scriptTokens.args)) {
    return {
      mutate: true,
      reason: "shell-redirection",
    };
  }

  if (command === "sed" && scriptArgs.some((arg) => arg.includes("-i"))) {
    return {
      mutate: true,
      reason: "shell-sed-in-place",
    };
  }

  if (command === "git" && scriptArgs.length > 0) {
    const gitSubcommand = scriptArgs[0];
    if (MUTATING_GIT_COMMANDS.has(gitSubcommand)) {
      return {
        mutate: true,
        reason: `shell-git-${gitSubcommand}`,
      };
    }

    return {
      mutate: false,
      reason: "shell-git-readonly",
    };
  }

  if (MUTATING_SHELL_COMMANDS.has(command)) {
    return {
      mutate: true,
      reason: `shell-${command}`,
    };
  }

  if (READ_ONLY_SHELL_COMMANDS.has(command)) {
    return {
      mutate: false,
      reason: `shell-${command}-read-only`,
    };
  }

  return {
    mutate: true,
    reason: `shell-unknown-${command}`,
  };
}

export function shouldInvalidateContextCacheFromToolEvent(
  event: unknown,
): MutationDecision {
  const normalized = normalizeToolEvent(event);
  const tool = normalized?.tool;

  if (!tool || normalized === null) {
    return {
      mutate: false,
      reason: "non-tool-event",
    };
  }

  if (READ_ONLY_TOOLS.has(tool)) {
    return {
      mutate: false,
      reason: `readonly-tool:${tool}`,
    };
  }

  if (MUTATING_TOOLS.has(tool)) {
    return {
      mutate: true,
      reason: `mutating-tool:${tool}`,
    };
  }

  if (tool === "bash" || tool === "sh") {
    const rawCommand =
      typeof normalized.args?.command === "string" ? normalized.args.command : undefined;

    if (!rawCommand) {
      return {
        mutate: true,
        reason: `${tool}-missing-command`,
      };
    }

    return classifyBashMutation(rawCommand);
  }

  return {
    mutate: true,
    reason: `unknown-tool:${tool}`,
  };
}
