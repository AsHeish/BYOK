import { afterEach, describe, expect, it, vi } from "vitest";
import { buildModelsUrl, fetchProviderModels } from "./providerModels";

afterEach(() => vi.unstubAllGlobals());

describe("provider model list", () => {
  it("derives the models URL from any configured endpoint", () => {
    expect(buildModelsUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/models",
    );
    expect(buildModelsUrl("https://host/v1/chat/completions/")).toBe(
      "https://host/v1/models",
    );
    expect(buildModelsUrl("https://host/v1/responses")).toBe(
      "https://host/v1/models",
    );
  });

  it("returns sorted unique model ids and strips the models/ prefix", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "models/b" },
              { id: "a" },
              { id: "a" },
              { object: "x" },
            ],
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchProviderModels("https://host/v1", " key "),
    ).resolves.toEqual(["a", "b"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://host/v1/models",
      expect.objectContaining({
        headers: { Authorization: "Bearer key" },
      }),
    );
  });

  it("reports HTTP failures and malformed bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 401 })),
    );
    await expect(fetchProviderModels("https://host/v1", "k")).rejects.toThrow(
      "HTTP 401",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }))),
    );
    await expect(fetchProviderModels("https://host/v1", "k")).rejects.toThrow(
      "unrecognized",
    );
  });
});
