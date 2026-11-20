import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Bitmap } from "./calendar/bitmap.js";
import { DEVICE_HEADER_SIZE, DEVICE_MODE_SIZE } from "./calendar/device.js";
import { writeBitmapPng } from "./calendar/export.js";
import { CalendarService, nextSlot } from "./calendar/service.js";
import { config } from "./config.js";
import { type App, createApp } from "./server.js";
import { TrendingService } from "./trending/service.js";
import { MemoryKv, type ModelSnapshot } from "./trending/trending.js";

const model: ModelSnapshot = {
  rank: 1,
  modelId: "owner/model",
  pipeline: "text-generation",
  parameters: 7e9,
  updatedAt: "2026-09-29T00:00:00.000Z",
  downloads: 12_345,
  likes: 67,
};

describe("unified server", () => {
  let app: App;
  let base: string;
  let fetches = 0;

  beforeAll(async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "cal-"));
    const run = join(outputDir, "20261118-1600_auto_test");
    mkdirSync(run);
    writeFileSync(join(run, "meta.json"), JSON.stringify({ name: "auto", generatedAt: "2026-11-18T08:00:00Z" }));
    writeFileSync(join(run, "ticker.json"), "{}");
    writeFileSync(join(run, "frame.bin"), Buffer.alloc(15000));
    const frame = new Bitmap(400, 300);
    frame.set(1, 0, 1);
    writeBitmapPng(join(run, "frame.png"), frame);
    writeBitmapPng(join(run, "ticker.png"), new Bitmap(104, 200, 1));
    writeFileSync(join(run, "ticker.json"), JSON.stringify({ stripHeight: 200, scrolls: true, entries: [{ y: 0 }, { y: 90 }] }));
    writeFileSync(join(run, "animation.json"), JSON.stringify({ frames: 2, fps: 4, dither: "bayer4" }));
    // bayer4 in the legacy folder, floyd per dither, threshold as a still, no atkinson.
    for (const id of ["00", "01"]) {
      writeBitmapPng(join(run, "animation", `frame-${id}.png`), frame);
      writeBitmapPng(join(run, "animation", "floyd", `frame-${id}.png`), frame);
    }
    writeBitmapPng(join(run, "variants", "frame-threshold.png"), frame);
    const cfg = { ...config, calendar: { ...config.calendar, outputDir, runOnStart: false } };
    const trending = new TrendingService(cfg, {
      kv: new MemoryKv(),
      fetchModels: async () => {
        fetches++;
        return [model];
      },
    });
    app = createApp(cfg, { trending, calendar: new CalendarService(cfg) });
    await new Promise<void>((ok) => app.server.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((ok) => app.server.close(() => ok())));

  it("serves health and the device TSV with Worker semantics", async () => {
    expect(await (await fetch(`${base}/healthz`)).text()).toBe("ok\n");
    const res = await fetch(`${base}/api/trending.tsv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("transfer-encoding")).toBeNull();
    const body = await res.text();
    expect(Number(res.headers.get("content-length"))).toBe(Buffer.byteLength(body));
    expect(body).toMatch(/^v1\t\S+\+08:00\t-\tOK\n/);
    expect(body).toContain("\tNEW\t\towner/model\ttext-generation\t7000000000\t");
    await fetch(`${base}/api/trending.tsv`);
    expect(fetches).toBe(1);
  });

  it("renders the debug pages", async () => {
    for (const path of ["/", "/trending", "/calendar/"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    }
    expect(await (await fetch(`${base}/trending`)).text()).toContain("owner/model");
    const redirect = await fetch(`${base}/calendar`, { redirect: "manual" });
    expect(redirect.status).toBe(301);
  });

  it("serves the latest calendar output and blocks path traversal", async () => {
    const bin = await fetch(`${base}/calendar/latest/frame.bin`);
    expect(bin.status).toBe(200);
    expect((await bin.arrayBuffer()).byteLength).toBe(15000);
    expect((await fetch(`${base}/calendar/..%2f..%2fpackage.json`)).status).toBe(403);
    expect((await fetch(`${base}/calendar/latest/..%2f..%2f..%2fpackage.json`)).status).toBe(403);
    const status = await (await fetch(`${base}/api/calendar/status`)).json();
    expect(status.latest).toBe("20261118-1600_auto_test");
  });

  it("serves the device calendar bundle with ETag revalidation", async () => {
    const res = await fetch(`${base}/api/calendar/device.bin`);
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag")!;
    expect(etag).toBe('"20261118-1600_auto_test"');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.toString("ascii", 0, 4)).toBe("CAL1");
    const u16 = (o: number) => buf.readUInt16LE(o);
    expect([u16(4), u16(6), u16(8)]).toEqual([3, 3, 4]);
    expect([u16(10), u16(12), u16(14), u16(16)]).toEqual([6, 6, 262, 288]);
    expect([u16(22), u16(26), u16(28), u16(30), u16(36)]).toEqual([104, 200, 1, 2, 0]);
    const modeTable = DEVICE_HEADER_SIZE + 4;
    expect([u16(DEVICE_HEADER_SIZE), u16(DEVICE_HEADER_SIZE + 2)]).toEqual([0, 90]);
    const modes = [0, 1, 2].map((i) => {
      const at = modeTable + i * DEVICE_MODE_SIZE;
      return [buf.toString("ascii", at, at + 12).replace(/\0+$/, ""), u16(at + 12)];
    });
    expect(modes).toEqual([["bayer4", 2], ["floyd", 2], ["threshold", 1]]);
    const baseAt = modeTable + 3 * DEVICE_MODE_SIZE;
    // One keyframe per mode; the identical second frames are empty 4-byte deltas.
    expect(buf.length).toBe(baseAt + 15000 + 3 * 33 * 288 + 2 * 4 + 13 * 200);
    // LSB-first: pixel (1, 0) is bit 1 of the first frame byte.
    expect(buf[baseAt]).toBe(0b10);

    const again = await fetch(`${base}/api/calendar/device.bin`, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
  });

  it("answers 404 for missing or deleted output files without crashing", async () => {
    expect((await fetch(`${base}/calendar/20261118-1600_auto_test/animation/frame-04.png`)).status).toBe(404);
    expect((await fetch(`${base}/calendar/20261118-1600_auto_test`)).status).toBe(404);
    expect(await (await fetch(`${base}/healthz`)).text()).toBe("ok\n");
  });

  it("requires POST for actions", async () => {
    expect((await fetch(`${base}/api/calendar/generate`)).status).toBe(405);
    expect((await fetch(`${base}/api/trending/refresh`)).status).toBe(405);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

describe("nextSlot", () => {
  it("aligns to the interval from local midnight", () => {
    const at = nextSlot(new Date(2026, 10, 18, 16, 17), 60);
    expect([at.getHours(), at.getMinutes()]).toEqual([17, 0]);
    expect(nextSlot(new Date(2026, 10, 18, 17, 0), 60).getHours()).toBe(18);
    expect(nextSlot(new Date(2026, 10, 18, 23, 50), 30).getDate()).toBe(19);
  });
});
