import { createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { DeviceBundleCache } from "./calendar/device.js";
import { galleryHtml } from "./calendar/gallery.js";
import { CalendarService } from "./calendar/service.js";
import { config as defaultConfig, type Config } from "./config.js";
import { indexPage, trendingPage } from "./pages.js";
import { TrendingService } from "./trending/service.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".gif": "image/gif",
  ".bin": "application/octet-stream",
};

export interface App {
  server: Server;
  trending: TrendingService;
  calendar: CalendarService;
}

function send(res: ServerResponse, code: number, body: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

const json = (res: ServerResponse, code: number, body: unknown) => send(res, code, JSON.stringify(body), MIME[".json"]);

async function sendResponse(res: ServerResponse, r: Response): Promise<void> {
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => (headers[k] = v));
  const body = Buffer.from(await r.arrayBuffer());
  // The firmware reads the raw socket stream, so it cannot decode chunked bodies.
  headers["content-length"] = String(body.length);
  res.writeHead(r.status, headers);
  res.end(body);
}

function sendFile(res: ServerResponse, path: string): void {
  // Outputs can be pruned between the check and the read, so stream errors must not escape.
  const stream = createReadStream(path);
  stream.on("error", () => {
    if (!res.headersSent) send(res, 404, "not_found\n");
    else res.destroy();
  });
  stream.on("open", () => {
    if (!statSync(path).isFile()) return stream.destroy(new Error("not a file"));
    res.writeHead(200, {
      "content-type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    stream.pipe(res);
  });
}

/** Resolve a URL path inside `root`, rejecting anything that escapes it. */
function safePath(root: string, rel: string): string | null {
  const base = normalize(root + sep);
  const full = normalize(join(root, rel));
  return full.startsWith(base) ? full : null;
}

export function createApp(cfg: Config, deps: Partial<Pick<App, "trending" | "calendar">> = {}): App {
  const trending = deps.trending ?? new TrendingService(cfg);
  const calendar = deps.calendar ?? new CalendarService(cfg);
  const deviceBundles = new DeviceBundleCache();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://local");
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return send(res, 400, "bad_path\n");
    }
    const method = req.method ?? "GET";
    const postOnly = () => send(res, 405, "use POST\n");

    if (path === "/healthz") return send(res, 200, "ok\n");
    if (path === "/api/trending.tsv") return sendResponse(res, await trending.tsv());
    if (path === "/api/trending/refresh") {
      if (method !== "POST") return postOnly();
      void trending.refresh();
      return json(res, 202, { started: true });
    }
    if (path === "/api/calendar/status") return json(res, 200, calendar.status());
    if (path === "/api/calendar/generate") {
      if (method !== "POST") return postOnly();
      return json(res, 202, { started: calendar.trigger() });
    }
    if (path === "/api/calendar/device.bin") {
      const latest = calendar.outputs()[0];
      if (!latest) return send(res, 404, "no_output_yet\n");
      const etag = `"${latest.name}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { etag, "cache-control": "no-store" });
        return void res.end();
      }
      const body = deviceBundles.get(join(calendar.outputDir, latest.name), latest.name);
      res.writeHead(200, {
        "content-type": MIME[".bin"],
        "content-length": body.length,
        etag,
        "cache-control": "no-store",
      });
      return void res.end(body);
    }
    if (path === "/api/status")
      return json(res, 200, { trending: await trending.status(), calendar: calendar.status() });

    if (path === "/" || path === "/index.html")
      return send(res, 200, indexPage(await trending.status(), calendar.status(), cfg.city.name), MIME[".html"]);
    if (path === "/trending")
      return send(res, 200, trendingPage(await trending.state(), await trending.status()), MIME[".html"]);

    if (path === "/calendar") {
      res.writeHead(301, { location: "/calendar/" });
      return void res.end();
    }
    if (path === "/calendar/" || path === "/calendar/index.html")
      return send(
        res,
        200,
        galleryHtml(calendar.outputDir, { live: true, limit: cfg.calendar.galleryLimit }),
        MIME[".html"],
      );
    if (path === "/calendar/latest" || path.startsWith("/calendar/latest/")) {
      const latest = calendar.outputs()[0];
      if (!latest) return send(res, 404, "no_output_yet\n");
      const file = path.slice("/calendar/latest".length).replace(/^\/+/, "") || "frame.png";
      const full = safePath(calendar.outputDir, join(latest.name, file));
      return full ? sendFile(res, full) : send(res, 403, "forbidden\n");
    }
    if (path.startsWith("/calendar/")) {
      const full = safePath(calendar.outputDir, path.slice("/calendar/".length));
      return full ? sendFile(res, full) : send(res, 403, "forbidden\n");
    }
    return send(res, 404, "not_found\n");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(`[http] ${req.method} ${req.url}: ${(err as Error).message}`);
      if (!res.headersSent) send(res, 500, "internal_error\n");
      else res.destroy();
    });
  });
  return { server, trending, calendar };
}

export async function main(): Promise<void> {
  const cfg = defaultConfig;
  const app = createApp(cfg);
  const { host, port } = cfg.http;
  app.server.listen(port, host, () => {
    const shown = host === "0.0.0.0" ? "localhost" : host;
    console.log(`[http] listening on http://${shown}:${port}/`);
    console.log(`[http] device API http://${shown}:${port}/api/trending.tsv`);
    console.log(`[http] device calendar http://${shown}:${port}/api/calendar/device.bin`);
    if (!cfg.llm.apiKey) console.warn("[calendar] LLM_API_KEY not set, scheduled runs will use the fallback scene");
  });
  app.trending.start();
  app.calendar.start();

  const stop = () => {
    console.log("shutting down");
    app.trending.stop();
    app.calendar.stop();
    app.server.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
