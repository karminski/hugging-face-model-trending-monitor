import { fetch as undiciFetch, ProxyAgent } from "undici";
import type { Config } from "../config.js";
import { FileKv } from "./file-kv.js";
import {
  fetchHuggingFaceModels,
  getTrendingResponse,
  huggingFaceUrl,
  type KvStore,
  type ModelSnapshot,
  readState,
  type TrendingState,
} from "./trending.js";

export interface TrendingStatus {
  refreshing: boolean;
  lastRefreshAt: string | null;
  lastError: string | null;
  nextRefreshAt: string | null;
  refreshMin: number;
  source: string;
  fetchedAt: string | null;
  stale: boolean | null;
}

/** `fetch` bound to an HTTP proxy, so only Hugging Face traffic goes through it. */
function proxiedFetch(proxy: string): typeof fetch {
  const dispatcher = new ProxyAgent(proxy);
  return ((input: string | URL, init?: RequestInit) =>
    undiciFetch(input, { ...(init as object), dispatcher })) as unknown as typeof fetch;
}

export interface TrendingServiceOptions {
  kv?: KvStore;
  fetchModels?: () => Promise<ModelSnapshot[]>;
}

/** HF Trending snapshot kept in a local file, refreshed on a timer and lazily on request. */
export class TrendingService {
  readonly kv: KvStore;
  private readonly fetchModels: () => Promise<ModelSnapshot[]>;
  private readonly maxAgeMs: number;
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;
  private lastRefreshAt: string | null = null;
  private lastError: string | null = null;
  private nextRefreshAt: string | null = null;

  constructor(
    private readonly cfg: Config,
    opts: TrendingServiceOptions = {},
  ) {
    this.kv = opts.kv ?? new FileKv(cfg.dataDir);
    const url = huggingFaceUrl(cfg.trending.hfBaseUrl);
    const fetchImpl = cfg.trending.hfProxy ? proxiedFetch(cfg.trending.hfProxy) : fetch;
    this.fetchModels = opts.fetchModels ?? (() => fetchHuggingFaceModels(fetchImpl, url));
    this.maxAgeMs = cfg.trending.refreshMin * 60_000;
  }

  /** Device endpoint: identical semantics to the former Cloudflare Worker. */
  tsv(): Promise<Response> {
    return getTrendingResponse({ kv: this.kv, now: Date.now(), fetchModels: this.fetchModels, maxAgeMs: this.maxAgeMs });
  }

  state(): Promise<TrendingState | null> {
    return readState(this.kv);
  }

  /** Force a fetch from Hugging Face; concurrent callers share one request. */
  refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        const res = await getTrendingResponse({ kv: this.kv, now: Date.now(), fetchModels: this.fetchModels, maxAgeMs: 0 });
        const state = await this.state();
        this.lastError =
          res.status !== 200 ? (await res.text()).trim() : state?.stale ? "upstream failed, serving last snapshot" : null;
      } catch (err) {
        this.lastError = (err as Error).message;
      } finally {
        this.lastRefreshAt = new Date().toISOString();
        this.refreshing = null;
        if (this.lastError) console.warn(`[trending] refresh failed: ${this.lastError}`);
        else console.log("[trending] refreshed");
      }
    })();
    return this.refreshing;
  }

  start(): void {
    const tick = () => {
      this.nextRefreshAt = new Date(Date.now() + this.maxAgeMs).toISOString();
      this.timer = setTimeout(() => void this.refresh().finally(tick), this.maxAgeMs);
    };
    void this.state().then((s) => {
      const age = s ? Date.now() - Date.parse(s.refreshedAt) : Infinity;
      if (age >= this.maxAgeMs) void this.refresh();
    });
    tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async status(): Promise<TrendingStatus> {
    const s = await this.state();
    return {
      refreshing: this.refreshing !== null,
      lastRefreshAt: this.lastRefreshAt,
      lastError: this.lastError,
      nextRefreshAt: this.nextRefreshAt,
      refreshMin: this.cfg.trending.refreshMin,
      source: this.cfg.trending.hfBaseUrl + (this.cfg.trending.hfProxy ? ` via ${this.cfg.trending.hfProxy}` : ""),
      fetchedAt: s?.fetchedAt ?? null,
      stale: s ? s.stale : null,
    };
  }
}
