import { describe, expect, it } from "vitest";

import {
  applyMovement,
  fetchHuggingFaceModels,
  getTrendingResponse,
  MemoryKv,
  parseHuggingFaceModels,
  HUGGING_FACE_URL,
  REFRESH_INTERVAL_MS,
  sanitizeField,
  toChinaTime,
  type ModelSnapshot,
} from "./trending";

const NOW = Date.parse("2026-09-30T02:00:00.000Z");

function model(rank: number, id: string): ModelSnapshot {
  return {
    rank,
    modelId: id,
    pipeline: "text-generation",
    parameters: 7_000_000_000,
    updatedAt: "2026-09-29T00:00:00.000Z",
    downloads: 1_000 + rank,
    likes: 100 + rank,
  };
}

describe("Hugging Face parsing", () => {
  it("maps trending fields and falls back when parameters are absent", () => {
    const models = parseHuggingFaceModels([
      {
        id: "owner/model\twith\ncontrols",
        pipeline_tag: "text-generation",
        downloads: 123,
        likes: 45,
        lastModified: "2026-09-29T00:00:00.000Z",
        safetensors: { total: 7000000000 },
      },
      {
        id: "owner/no-size",
        downloads: "bad",
        likes: null,
      },
    ]);

    expect(models[0]).toMatchObject({
      rank: 1,
      modelId: "owner/model with controls",
      parameters: 7000000000,
      downloads: 123,
      likes: 45,
    });
    expect(models[1]).toMatchObject({
      rank: 2,
      pipeline: "unknown",
      parameters: null,
      downloads: 0,
      likes: 0,
    });
  });

  it("removes non-ASCII characters and limits field length", () => {
    expect(sanitizeField("模型\tname", 8)).toBe("?? name");
    expect(sanitizeField("abcdefghijklmnopqrstuvwxyz", 8)).toBe("abcdefg~");
  });
});

describe("rank movement", () => {
  it("calculates rises, falls, unchanged, new, and dropped models", () => {
    const previous = [
      model(1, "falling"),
      model(2, "stable"),
      model(6, "rising"),
      model(4, "dropped"),
    ];
    const current = [
      model(1, "rising"),
      model(2, "stable"),
      model(3, "falling"),
      model(4, "newcomer"),
    ];

    const ranked = applyMovement(previous, current);
    expect(ranked.map((item) => [item.modelId, item.movement, item.previousRank, item.rankDelta])).toEqual([
      ["rising", "UP", 6, 5],
      ["stable", "SAME", 2, 0],
      ["falling", "DN", 1, -2],
      ["newcomer", "NEW", null, 0],
    ]);
    expect(ranked.some((item) => item.modelId === "dropped")).toBe(false);
  });

  it("marks every model as new on the first snapshot", () => {
    expect(applyMovement(null, [model(1, "first")])[0].movement).toBe("NEW");
  });
});

describe("trending endpoint state", () => {
  it("stores one snapshot and serves it until the hour expires", async () => {
    const kv = new MemoryKv();
    let fetches = 0;
    const fetchModels = async () => {
      fetches += 1;
      return [model(1, "first")];
    };

    const first = await getTrendingResponse({ kv, now: NOW, fetchModels });
    const second = await getTrendingResponse({
      kv,
      now: NOW + REFRESH_INTERVAL_MS - 1,
      fetchModels,
    });

    expect(fetches).toBe(1);
    const body = await first.text();
    expect(body.startsWith("v1\t2026-09-30T10:00:00+08:00\t-")).toBe(true);
    expect(body).toContain("2026-09-29T08:00:00+08:00");
    expect(body).toContain("first\ttext-generation");
    expect(await second.text()).toContain("NEW");
  });

  it("returns the last snapshot as stale when an upstream refresh fails", async () => {
    const kv = new MemoryKv();
    await getTrendingResponse({
      kv,
      now: NOW,
      fetchModels: async () => [model(1, "cached")],
    });

    const stale = await getTrendingResponse({
      kv,
      now: NOW + REFRESH_INTERVAL_MS,
      fetchModels: async () => {
        throw new Error("upstream down");
      },
    });
    const body = await stale.text();

    expect(stale.status).toBe(200);
    expect(body.startsWith("v1\t")).toBe(true);
    expect(body).toContain("\tSTALE\n");
    expect(body).toContain("cached");
  });

  it("returns 502 when the first upstream request fails", async () => {
    const response = await getTrendingResponse({
      kv: new MemoryKv(),
      now: NOW,
      fetchModels: async () => {
        throw new Error("offline");
      },
    });

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("upstream_error");
  });
});

describe("China time", () => {
  it("shifts UTC timestamps to UTC+8 and keeps the day boundary", () => {
    expect(toChinaTime("2026-09-30T02:00:00.000Z")).toBe("2026-09-30T10:00:00+08:00");
    expect(toChinaTime("2026-09-29T18:05:00.000Z")).toBe("2026-09-30T02:05:00+08:00");
    expect(toChinaTime("-")).toBe("-");
  });
});

describe("live Hugging Face API", () => {
  it.runIf(process.env.LIVE === "1")(
    "fetches the current trending models",
    async () => {
      const mirrorUrl = HUGGING_FACE_URL.replace(
        "https://huggingface.co",
        "https://hf-mirror.com",
      );
      let models;
      try {
        models = await fetchHuggingFaceModels();
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (!/fetch failed|timeout|ECONN|ENOTFOUND/i.test(message)) {
          throw error;
        }
        models = await fetchHuggingFaceModels(fetch, mirrorUrl);
      }

      expect(models.length).toBeGreaterThan(0);
      expect(models.length).toBeLessThanOrEqual(10);
      expect(models[0].rank).toBe(1);
      expect(models[0].modelId).toMatch(/^[ -~]+$/);
      expect(models[0].downloads).toBeGreaterThanOrEqual(0);
      expect(models[0].likes).toBeGreaterThanOrEqual(0);
    },
    30000,
  );
});
