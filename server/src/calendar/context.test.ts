import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../config.js";
import { fetchWeather, parseLocalDate, weatherKindFromWmo } from "./context.js";
import { sampleContext } from "./test-helpers.js";

describe("fetchWeather", () => {
  afterEach(() => vi.unstubAllGlobals());
  const ok = {
    current: { temperature_2m: 9.6, weather_code: 61 },
    daily: { temperature_2m_max: [12.2], temperature_2m_min: [5.1] },
  };
  const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  it("caches a good reading and reuses it when the API is down", async () => {
    quiet();
    const cachePath = join(mkdtempSync(join(tmpdir(), "wx-")), "weather.json");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(ok))));
    const live = await fetchWeather(31.23, 121.47, { cachePath, attempts: 1 });
    expect(live).toMatchObject({ kind: "rain", temp: 10, source: "open-meteo" });

    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const cached = await fetchWeather(31.23, 121.47, { cachePath, attempts: 1 });
    expect(cached).toMatchObject({ kind: "rain", temp: 10, source: "cache" });
  });

  it("ignores stale caches", async () => {
    quiet();
    const cachePath = join(mkdtempSync(join(tmpdir(), "wx-")), "weather.json");
    writeFileSync(cachePath, JSON.stringify({ at: Date.now() - 4 * 3600_000, lat: 1, lon: 2, weather: { kind: "snow" } }));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const w = await fetchWeather(1, 2, { cachePath, attempts: 1 });
    expect(w.source).toBe("unavailable");
  });
});

describe("calendar context", () => {
  it("detects the winter solstice", () => {
    const c = sampleContext("2026-12-22T19:30");
    expect(c.solarTerm).toBe("冬至");
    expect(c.highlight).toEqual({ title: "冬至", subtitle: "二十四节气" });
    expect(c.isNight).toBe(true);
    expect(c.weekdayZh).toBe("周二");
  });

  it("puts festivals ahead of solar terms", () => {
    const c = sampleContext("2027-02-05T22:00");
    expect(c.festivals).toContain("除夕");
    expect(c.highlight.title).toBe("除夕");
  });

  it("counts days to the next solar term on ordinary days", () => {
    const c = sampleContext("2026-11-18T14:25");
    expect(c.solarTerm).toBeNull();
    expect(c.nextSolarTerm.name).toBe("小雪");
    expect(c.nextSolarTerm.daysLeft).toBeGreaterThan(0);
    expect(c.highlight.title).toBe("距小雪");
    expect(c.highlight.subtitle).toBe(`还有 ${c.nextSolarTerm.daysLeft} 天`);
  });

  it("includes solar-calendar festivals", () => {
    expect(sampleContext("2026-10-01T09:00").festivals).toContain("国庆节");
  });

  it("maps WMO weather codes", () => {
    expect(weatherKindFromWmo(0)).toBe("clear");
    expect(weatherKindFromWmo(3)).toBe("overcast");
    expect(weatherKindFromWmo(63)).toBe("rain");
    expect(weatherKindFromWmo(75)).toBe("snow");
    expect(weatherKindFromWmo(95)).toBe("thunder");
  });

  it("parses local dates", () => {
    const d = parseLocalDate("2026-12-22T19:30");
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 11, 22, 19, 30]);
    expect(() => parseLocalDate("tomorrow")).toThrow();
  });
});
