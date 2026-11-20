import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileKv } from "./file-kv.js";
import { getTrendingResponse, type ModelSnapshot } from "./trending.js";

const tempDir = () => mkdtempSync(join(tmpdir(), "kv-"));

const snapshot = (id: string): ModelSnapshot => ({
  rank: 1,
  modelId: id,
  pipeline: "text-generation",
  parameters: null,
  updatedAt: "2026-09-29T00:00:00.000Z",
  downloads: 1,
  likes: 1,
});

describe("FileKv", () => {
  it("round-trips values and leaves no temp files", async () => {
    const dir = join(tempDir(), "nested");
    const kv = new FileKv(dir);
    await kv.put("trending-state", '{"a":1}');
    expect(await kv.get("trending-state")).toBe('{"a":1}');
    expect(readdirSync(dir)).toEqual(["trending-state.json"]);
  });

  it("returns null for missing keys", async () => {
    expect(await new FileKv(tempDir()).get("trending-state")).toBeNull();
  });

  it("rejects keys that could escape the directory", async () => {
    await expect(new FileKv(tempDir()).put("../x", "1")).rejects.toThrow("Invalid KV key");
  });

  it("refetches when the stored snapshot is corrupt", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "trending-state.json"), "{not json");
    const res = await getTrendingResponse({
      kv: new FileKv(dir),
      now: Date.now(),
      fetchModels: async () => [snapshot("fresh/model")],
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("fresh/model");
    expect(existsSync(join(dir, "trending-state.json"))).toBe(true);
  });
});
