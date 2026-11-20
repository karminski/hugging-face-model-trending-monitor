import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { z } from "zod";

/** The `server/` package directory. */
export const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Repository root, home of the single shared `.env`. */
export const REPO_DIR = join(ROOT_DIR, "..");

dotenv.config({ path: join(REPO_DIR, ".env"), quiet: true });

const flag = z.enum(["0", "1"]);

const schema = z.object({
  LLM_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  LLM_API_KEY: z.string().default(""),
  LLM_MODEL: z.string().min(1).default("gpt-4o-mini"),
  LLM_TEMPERATURE: z.coerce.number().default(0.9),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).default(3),
  LLM_JSON_MODE: flag.default("1"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),

  CITY_NAME: z.string().min(1).default("上海"),
  CITY_LAT: z.coerce.number().min(-90).max(90).default(31.23),
  CITY_LON: z.coerce.number().min(-180).max(180).default(121.47),
  TZ: z.string().default("Asia/Shanghai"),

  HTTP_HOST: z.string().default("127.0.0.1"),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8787),

  HF_BASE_URL: z.string().url().default("https://huggingface.co"),
  HF_PROXY: z.union([z.literal(""), z.string().url()]).default(""),
  TRENDING_REFRESH_MIN: z.coerce.number().int().positive().default(60),

  CALENDAR_INTERVAL_MIN: z.coerce.number().int().positive().default(60),
  CALENDAR_RUN_ON_START: flag.default("1"),
  CALENDAR_KEEP: z.coerce.number().int().min(0).default(0),
  CALENDAR_GALLERY_LIMIT: z.coerce.number().int().positive().default(24),

  DATA_DIR: z.string().default("data"),
});

function parseEnv(): z.infer<typeof schema> {
  const r = schema.safeParse(process.env);
  if (r.success) return r.data;
  const lines = r.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
  throw new Error(`Invalid .env (${join(REPO_DIR, ".env")}):\n${lines.join("\n")}`);
}

const env = parseEnv();

// Node re-reads TZ at runtime, so every Date below is in the configured zone.
process.env.TZ = env.TZ;

if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy)
  setGlobalDispatcher(new EnvHttpProxyAgent());

const dataDir = resolve(ROOT_DIR, env.DATA_DIR);

export const config = {
  llm: {
    baseUrl: env.LLM_BASE_URL.replace(/\/+$/, ""),
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
    temperature: env.LLM_TEMPERATURE,
    maxRetries: env.LLM_MAX_RETRIES,
    jsonMode: env.LLM_JSON_MODE === "1",
    timeoutMs: env.LLM_TIMEOUT_MS,
  },
  city: { name: env.CITY_NAME, lat: env.CITY_LAT, lon: env.CITY_LON },
  tz: env.TZ,
  http: { host: env.HTTP_HOST, port: env.HTTP_PORT },
  dataDir,
  trending: {
    hfBaseUrl: env.HF_BASE_URL.replace(/\/+$/, ""),
    /** HTTP proxy used only for Hugging Face requests; empty = direct (or HTTPS_PROXY). */
    hfProxy: env.HF_PROXY,
    refreshMin: env.TRENDING_REFRESH_MIN,
    statePath: join(dataDir, "trending-state.json"),
  },
  calendar: {
    outputDir: join(dataDir, "calendar"),
    weatherCachePath: join(dataDir, "cache", "weather.json"),
    intervalMin: env.CALENDAR_INTERVAL_MIN,
    runOnStart: env.CALENDAR_RUN_ON_START === "1",
    /** Number of scheduled outputs to keep; 0 keeps everything. */
    keep: env.CALENDAR_KEEP,
    galleryLimit: env.CALENDAR_GALLERY_LIMIT,
  },
};

export type Config = typeof config;
