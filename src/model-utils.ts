function pickString(
  obj: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Resolve model identity from payload shapes used by opencode hooks.
 *
 * Returns normalized "provider/model" only when explicit provider information
 * is present (or model id is already provider-qualified). If provider is
 * missing and id is unqualified, returns undefined instead of guessing.
 */
export function resolveLeadModel(
  model: unknown,
): string | undefined {
  if (!model || typeof model !== "object") return undefined;
  const raw = model as Record<string, unknown>;

  const provider = pickString(raw, ["provider", "providerID", "providerId"]);
  const id = pickString(raw, ["id", "modelID", "modelId"]);
  if (!id) return undefined;

  // Already provider-qualified.
  if (id.includes("/")) return id;

  if (provider) return `${provider}/${id}`;

  return undefined;
}
