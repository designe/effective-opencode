export interface ParsedCommand {
  command: string;
  args: string[];
}

function pushToken(tokens: string[], token: string, current: string): void {
  if (current.length > 0) {
    tokens.push(current);
  }
}

function flushToken(tokens: string[], current: string): string {
  if (current.length > 0) {
    tokens.push(current);
  }
  return "";
}

/**
 * Parse command text into argv-style tokens while preserving quoted segments.
 *
 * - Single-quoted content is kept verbatim until the next single quote.
 * - Double-quoted content keeps backslash escapes for "\" and "\\".
 * - Plain backslashes escape the next character.
 */
export function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let i = 0;

  while (i < command.length) {
    const char = command[i];

    if (inSingleQuote) {
      if (char === "'") {
        inSingleQuote = false;
      } else {
        token += char;
      }
      i += 1;
      continue;
    }

    if (inDoubleQuote) {
      if (char === "\\") {
        const next = command[i + 1];
        if (next === undefined) {
          i += 1;
          continue;
        }

        if (["\"", "$", "`", "\\", "n"].includes(next)) {
          token += next === "n" ? "n" : next;
          i += 2;
          continue;
        }

        token += next;
        i += 2;
        continue;
      }

      if (char === "\"") {
        inDoubleQuote = false;
        i += 1;
        continue;
      }

      token += char;
      i += 1;
      continue;
    }

    if (char === "'") {
      inSingleQuote = true;
      i += 1;
      continue;
    }

    if (char === "\"") {
      inDoubleQuote = true;
      i += 1;
      continue;
    }

    if (/\s/.test(char)) {
      token = flushToken(tokens, token);
      i += 1;
      continue;
    }

    if (char === "\\") {
      const next = command[i + 1];
      if (next !== undefined) {
        token += next;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    token += char;
    i += 1;
  }

  flushToken(tokens, token);
  return tokens;
}

export function parseBashCommand(rawCommand: string): ParsedCommand | null {
  const tokens = tokenizeShellCommand(rawCommand.trim());
  if (tokens.length === 0) return null;
  return {
    command: tokens[0],
    args: tokens.slice(1),
  };
}
