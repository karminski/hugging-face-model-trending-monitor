import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { ROOT_DIR } from "../../config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ORIGIN = "http://calendar.local";
const THREE_DIR = join(ROOT_DIR, "node_modules", "three", "build");
const RENDER_TIMEOUT_MS = 15000;
const FRAME_TIMEOUT_MS = 2000;

export interface SceneCtx {
  weather: { kind: string };
  isNight: boolean;
  hour: number;
  solarTerm: string | null;
  festivals: string[];
  dayPeriod: string;
}

export interface RenderRequest {
  code: string;
  width: number;
  height: number;
  ctx: SceneCtx;
  seed: number;
  /** Animation phases in [0, 1]; one RGBA frame is returned per entry. */
  ts: number[];
}

export type RenderResult = { ok: true; frames: Uint8Array[]; consoleErrors: string[] } | { ok: false; error: string };

/**
 * Prefers CHROMIUM_PATH, then Playwright's pinned build, then the newest Chromium
 * already present in the Playwright cache (downloads are slow on some networks).
 */
function findChromium(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const pinned = chromium.executablePath();
  if (existsSync(pinned)) return undefined;
  const cache = dirname(dirname(dirname(pinned)));
  if (!existsSync(cache)) return undefined;
  const candidates = readdirSync(cache)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const d of candidates)
    for (const sub of ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux64/chrome", "chrome-linux/chrome"]) {
      const p = join(cache, d, sub);
      if (existsSync(p)) {
        console.warn(`Playwright Chromium not installed, using ${p}`);
        return p;
      }
    }
  return undefined;
}

export class SceneRenderer {
  private constructor(private readonly browser: Browser) {}

  static async launch(): Promise<SceneRenderer> {
    const browser = await chromium.launch({
      headless: true,
      executablePath: findChromium(),
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    });
    return new SceneRenderer(browser);
  }

  /** Runs untrusted scene code in an isolated page with all network access blocked. */
  async render(req: RenderRequest): Promise<RenderResult> {
    const context = await this.browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) return route.abort("blockedbyclient");
      if (url.pathname === "/page.html")
        return route.fulfill({ contentType: "text/html", body: readFileSync(join(HERE, "page.html")) });
      if (url.pathname.startsWith("/three/")) {
        const file = normalize(join(THREE_DIR, url.pathname.slice("/three/".length)));
        if (file.startsWith(THREE_DIR))
          return route.fulfill({ contentType: "text/javascript", body: readFileSync(file) });
      }
      return route.fulfill({ status: 404, body: "" });
    });
    try {
      await page.goto(`${ORIGIN}/page.html`);
      await page.waitForFunction(() => (window as unknown as { rendererReady?: boolean }).rendererReady, null, {
        timeout: RENDER_TIMEOUT_MS,
      });
      const run = page.evaluate(
        (r) =>
          (
            window as unknown as {
              renderScene: (r: unknown) => Promise<{ ok: boolean; frames?: number[][]; error?: string }>;
            }
          ).renderScene(r),
        req,
      );
      const limitMs = RENDER_TIMEOUT_MS + req.ts.length * FRAME_TIMEOUT_MS;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`scene did not finish within ${limitMs / 1000}s`)), limitMs);
      });
      const res = await Promise.race([run, timeout]).finally(() => clearTimeout(timer));
      if (!res.ok) return { ok: false, error: res.error ?? "unknown render error" };
      return { ok: true, frames: res.frames!.map((f) => Uint8Array.from(f)), consoleErrors };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      await context.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
