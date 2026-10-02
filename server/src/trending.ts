export const PROTOCOL_VERSION = "v1";
export const MODEL_LIMIT = 10;
export const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
export const HUGGING_FACE_URL =
  "https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=10" +
  "&expand=pipeline_tag&expand=downloads&expand=likes&expand=lastModified&expand=safetensors";

const KV_KEY = "trending-state";

export type Movement = "UP" | "DN" | "SAME" | "NEW";

export interface ModelSnapshot {
  rank: number;
  modelId: string;
  pipeline: string;
  parameters: number | null;
  updatedAt: string;
  downloads: number;
  likes: number;
}

export interface RankedModel extends ModelSnapshot {
  previousRank: number | null;
  movement: Movement;
  rankDelta: number;
}

export interface TrendingState {
  fetchedAt: string;
  previousFetchedAt: string | null;
  refreshedAt: string;
  stale: boolean;
  models: RankedModel[];
}

export interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export class HuggingFaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HuggingFaceError";
  }
}

export function sanitizeField(value: string, maxLength: number): string {
  const ascii = value
    .replace(/[\t\r\n]+/g, " ")
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/\s+/g, " ")
    .trim();
  if (ascii.length <= maxLength) {
    return ascii;
  }
  return `${ascii.slice(0, Math.max(0, maxLength - 1))}~`;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseHuggingFaceModels(payload: unknown): ModelSnapshot[] {
  if (!Array.isArray(payload)) {
    throw new HuggingFaceError("Hugging Face response is not an array");
  }

  return payload.slice(0, MODEL_LIMIT).map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new HuggingFaceError(`Model ${index + 1} is not an object`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) {
      throw new HuggingFaceError(`Model ${index + 1} has no id`);
    }

    const safetensors = record.safetensors;
    const parameters =
      typeof safetensors === "object" && safetensors !== null
        ? finiteNumber((safetensors as Record<string, unknown>).total)
        : null;
    const downloads = finiteNumber(record.downloads) ?? 0;
    const likes = finiteNumber(record.likes) ?? 0;
    const updatedAt =
      typeof record.lastModified === "string" ? record.lastModified : "";

    return {
      rank: index + 1,
      modelId: sanitizeField(record.id, 64),
      pipeline: sanitizeField(
        typeof record.pipeline_tag === "string" ? record.pipeline_tag : "unknown",
        32,
      ),
      parameters,
      updatedAt: sanitizeField(updatedAt, 32),
      downloads,
      likes,
    };
  });
}

export function applyMovement(
  previous: ModelSnapshot[] | null,
  current: ModelSnapshot[],
): RankedModel[] {
  const previousRanks = new Map(previous?.map((model) => [model.modelId, model.rank]));
  return current.map((model) => {
    const previousRank = previousRanks.get(model.modelId);
    if (previousRank === undefined) {
      return { ...model, previousRank: null, movement: "NEW", rankDelta: 0 };
    }
    const rankDelta = previousRank - model.rank;
    const movement: Movement = rankDelta > 0 ? "UP" : rankDelta < 0 ? "DN" : "SAME";
    return { ...model, previousRank, movement, rankDelta };
  });
}

const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

export function toChinaTime(value: string): string {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) {
    return value;
  }
  // Shift the instant first, then read the UTC fields. Those digits are the UTC+8 clock.
  const shifted = new Date(instant + CHINA_OFFSET_MS).toISOString();
  return `${shifted.slice(0, 19)}+08:00`;
}

export function serializeTsv(state: TrendingState): string {
  const header = [
    PROTOCOL_VERSION,
    toChinaTime(state.fetchedAt),
    state.previousFetchedAt === null ? "-" : toChinaTime(state.previousFetchedAt),
    state.stale ? "STALE" : "OK",
  ].join("\t");
  const rows = state.models.map((model) =>
    [
      model.rank,
      model.previousRank ?? "",
      model.movement,
      model.movement === "NEW" ? "" : model.rankDelta,
      model.modelId,
      model.pipeline,
      model.parameters ?? "",
      toChinaTime(model.updatedAt),
      model.downloads,
      model.likes,
    ].join("\t"),
  );
  return `${[header, ...rows].join("\n")}\n`;
}

function isState(value: unknown): value is TrendingState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const state = value as Partial<TrendingState>;
  return typeof state.fetchedAt === "string" && Array.isArray(state.models);
}

async function readState(kv: KvStore): Promise<TrendingState | null> {
  const raw = await kv.get(KV_KEY);
  if (!raw) {
    return null;
  }
  const parsed: unknown = JSON.parse(raw);
  return isState(parsed) ? parsed : null;
}

export async function fetchHuggingFaceModels(
  fetchImpl: typeof fetch = fetch,
  url: string = HUGGING_FACE_URL,
): Promise<ModelSnapshot[]> {
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/json",
      "user-agent": "ultrahost-trending/1.0",
    },
  });
  if (!response.ok) {
    throw new HuggingFaceError(`Hugging Face returned HTTP ${response.status}`);
  }
  return parseHuggingFaceModels(await response.json());
}

export async function getTrendingResponse(options: {
  kv: KvStore;
  now: number;
  fetchModels?: () => Promise<ModelSnapshot[]>;
}): Promise<Response> {
  const current = await readState(options.kv);
  const fresh =
    current !== null && options.now - Date.parse(current.refreshedAt) < REFRESH_INTERVAL_MS;
  if (current && fresh) {
    return tsvResponse(serializeTsv(current));
  }

  try {
    const models = await (options.fetchModels ?? fetchHuggingFaceModels)();
    if (models.length === 0) {
      throw new HuggingFaceError("Hugging Face returned no models");
    }
    const fetchedAt = new Date(options.now).toISOString();
    const baseline = current?.models ?? null;
    const state: TrendingState = {
      fetchedAt,
      previousFetchedAt: current?.fetchedAt ?? null,
      refreshedAt: fetchedAt,
      stale: false,
      models: applyMovement(baseline, models),
    };
    await options.kv.put(KV_KEY, JSON.stringify(state));
    return tsvResponse(serializeTsv(state));
  } catch (error) {
    if (!current) {
      const message = error instanceof Error ? error.message : "Unknown upstream error";
      return new Response(`upstream_error\t${sanitizeField(message, 160)}\n`, {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    const staleState: TrendingState = {
      ...current,
      refreshedAt: new Date(options.now).toISOString(),
      stale: true,
    };
    await options.kv.put(KV_KEY, JSON.stringify(staleState));
    return tsvResponse(serializeTsv(staleState));
  }
}

function tsvResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

export class MemoryKv implements KvStore {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}
