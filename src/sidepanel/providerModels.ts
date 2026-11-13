export function buildModelsUrl(apiBaseUrl: string): string {
  const url = new URL(apiBaseUrl.trim());
  url.pathname = url.pathname
    .replace(/\/+$/, "")
    .replace(/\/(chat\/completions|responses)$/, "");
  url.pathname = `${url.pathname}/models`;
  return url.toString();
}

export async function fetchProviderModels(
  apiBaseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const response = await fetch(buildModelsUrl(apiBaseUrl), {
    headers: { Authorization: `Bearer ${apiKey.trim()}` },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Model list request failed (HTTP ${response.status}).`);
  }

  const body: unknown = await response.json();
  const entries = Array.isArray(body)
    ? body
    : ((body as { data?: unknown; models?: unknown } | null)?.data ??
      (body as { models?: unknown } | null)?.models);
  if (!Array.isArray(entries)) {
    throw new Error("Provider returned an unrecognized model list.");
  }

  const ids = entries
    .map((entry) => {
      const id =
        typeof entry === "string"
          ? entry
          : ((entry as { id?: unknown; name?: unknown } | null)?.id ??
            (entry as { name?: unknown } | null)?.name);
      return typeof id === "string" ? id.replace(/^models\//, "").trim() : "";
    })
    .filter(Boolean);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}
