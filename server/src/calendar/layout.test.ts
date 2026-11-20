import { describe, expect, it } from "vitest";
import { parseBdf, wrapText } from "./bdf.js";
import { Bitmap } from "./bitmap.js";
import "../config.js";
import { compose, LAYOUT, type Rect, renderTickerStrip, SCREEN, TICKER_VIEWPORT, tickerEntries } from "./layout.js";
import { fakeFont, sampleContext } from "./test-helpers.js";

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("layout", () => {
  it("keeps panels on screen and apart", () => {
    const rects = Object.values(LAYOUT);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(SCREEN.width);
      expect(r.y + r.h).toBeLessThanOrEqual(SCREEN.height);
    }
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i]!, rects[j]!)).toBe(false);
  });

  it("wraps CJK text and avoids punctuation at line start", () => {
    const font = fakeFont();
    const lines = wrapText(font, "一二三四五六七八，九十", 96);
    expect(lines).toEqual(["一二三四五六七", "八，九十"]);
    for (const l of lines) expect([...l].length * 12).toBeLessThanOrEqual(96);
  });

  it("builds a ticker strip with literary lines first, then facts", () => {
    const font = fakeFont();
    const ctx = sampleContext();
    const entries = tickerEntries(ctx, ["雪落在窗外。", "  "]);
    expect(entries[0]).toBe("雪落在窗外。");
    expect(entries).toContain("今日冬至");
    const strip = renderTickerStrip(font, entries);
    expect(strip.bitmap.width).toBe(TICKER_VIEWPORT.w);
    const sum = strip.entries.reduce((n, e) => n + e.height, 0);
    expect(strip.bitmap.height).toBe(sum + 14 * entries.length);
    expect(strip.entries[0]!.y).toBe(0);
  });

  it("composes a 400x300 frame", () => {
    const { frame } = compose(fakeFont(), sampleContext(), new Bitmap(262, 288), ["测试"]);
    expect([frame.width, frame.height]).toEqual([400, 300]);
    expect(frame.get(LAYOUT.ticker.x + 20, LAYOUT.ticker.y + 2)).toBe(1);
    expect(frame.pack().length).toBe(15000);
  });
});

describe("BDF parser", () => {
  it("reads glyph bitmaps", () => {
    const font = parseBdf(
      [
        "STARTFONT 2.1",
        "FONT_ASCENT 10",
        "FONT_DESCENT 2",
        "STARTCHAR A",
        "ENCODING 65",
        "DWIDTH 6 0",
        "BBX 4 2 0 0",
        "BITMAP",
        "90",
        "F0",
        "ENDCHAR",
        "ENDFONT",
      ].join("\n"),
    );
    const g = font.glyphs.get(65)!;
    expect(g.advance).toBe(6);
    expect([...g.rows[0]!]).toEqual([1, 0, 0, 1]);
    expect([...g.rows[1]!]).toEqual([1, 1, 1, 1]);
  });
});
