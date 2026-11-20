import type { BdfFont, Glyph } from "./bdf.js";
import { buildCalendar, weatherOverride } from "./context.js";

/** Font whose only glyph is a filled 10x10 '?', so every character is 12px wide. */
export function fakeFont(): BdfFont {
  const g: Glyph = {
    width: 10,
    height: 10,
    xoff: 1,
    yoff: 0,
    advance: 12,
    rows: Array.from({ length: 10 }, () => new Uint8Array(10).fill(1)),
  };
  return { ascent: 10, descent: 2, lineHeight: 12, glyphs: new Map([[0x3f, g]]) };
}

export function sampleContext(iso = "2026-12-22T19:30") {
  const [d, t] = iso.split("T");
  const [y, m, day] = d!.split("-").map(Number);
  const [h, mi] = t!.split(":").map(Number);
  return buildCalendar(new Date(y!, m! - 1, day!, h!, mi!), "上海", weatherOverride("snow", -3));
}
