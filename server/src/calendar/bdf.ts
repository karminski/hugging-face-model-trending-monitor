import { readFileSync } from "node:fs";
import type { Bitmap, Ink } from "./bitmap.js";

export interface Glyph {
  width: number;
  height: number;
  xoff: number;
  yoff: number;
  advance: number;
  rows: Uint8Array[];
}

export interface BdfFont {
  ascent: number;
  descent: number;
  lineHeight: number;
  glyphs: Map<number, Glyph>;
}

export function parseBdf(src: string): BdfFont {
  const glyphs = new Map<number, Glyph>();
  let ascent = 0;
  let descent = 0;
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("FONT_ASCENT ")) ascent = Number(line.slice(12));
    else if (line.startsWith("FONT_DESCENT ")) descent = Number(line.slice(13));
    else if (line.startsWith("STARTCHAR")) {
      let code = -1;
      let advance = 0;
      let bbx = [0, 0, 0, 0];
      const rows: Uint8Array[] = [];
      for (i++; i < lines.length; i++) {
        const l = lines[i]!;
        if (l.startsWith("ENCODING ")) code = Number(l.slice(9));
        else if (l.startsWith("DWIDTH ")) advance = Number(l.split(" ")[1]);
        else if (l.startsWith("BBX ")) bbx = l.slice(4).trim().split(/\s+/).map(Number);
        else if (l === "BITMAP") {
          for (i++; i < lines.length && lines[i] !== "ENDCHAR"; i++) {
            const hex = lines[i]!.trim();
            const row = new Uint8Array(bbx[0]!);
            for (let x = 0; x < row.length; x++) {
              const nibble = parseInt(hex[x >> 2] ?? "0", 16);
              row[x] = (nibble >> (3 - (x & 3))) & 1;
            }
            rows.push(row);
          }
          break;
        }
      }
      if (code >= 0)
        glyphs.set(code, { width: bbx[0]!, height: bbx[1]!, xoff: bbx[2]!, yoff: bbx[3]!, advance, rows });
    }
  }
  // FONT_ASCENT/DESCENT include generous padding; use the ink box of a CJK and a descender glyph instead.
  let top = 0;
  let bottom = 0;
  for (const ch of "国g") {
    const g = glyphs.get(ch.codePointAt(0)!);
    if (!g) continue;
    top = Math.max(top, g.yoff + g.height);
    bottom = Math.max(bottom, -g.yoff);
  }
  if (top > 0) {
    ascent = top;
    descent = bottom;
  }
  return { ascent, descent, lineHeight: ascent + descent, glyphs };
}

export function loadBdf(path: string): BdfFont {
  return parseBdf(readFileSync(path, "utf8"));
}

/** Keeps the primary font's metrics and glyphs, borrowing only glyphs it lacks. */
export function mergeFonts(primary: BdfFont, ...fallbacks: BdfFont[]): BdfFont {
  const glyphs = new Map(primary.glyphs);
  for (const f of fallbacks) for (const [code, g] of f.glyphs) if (!glyphs.has(code)) glyphs.set(code, g);
  return { ...primary, glyphs };
}

export function missingGlyphs(font: BdfFont, text: string): string[] {
  const out = new Set<string>();
  for (const ch of text) if (!/\s/.test(ch) && !font.glyphs.has(ch.codePointAt(0)!)) out.add(ch);
  return [...out];
}

function glyphFor(font: BdfFont, ch: string): Glyph | undefined {
  return font.glyphs.get(ch.codePointAt(0)!) ?? font.glyphs.get(0x3f);
}

export function measureText(font: BdfFont, text: string, scale = 1): number {
  let w = 0;
  for (const ch of text) w += (glyphFor(font, ch)?.advance ?? 0) * scale;
  return w;
}

/** Draws text with its top edge at `y`. Returns the advance width. */
export function drawText(
  bmp: Bitmap,
  font: BdfFont,
  text: string,
  x: number,
  y: number,
  ink: Ink = 1,
  scale = 1,
): number {
  const baseline = y + font.ascent * scale;
  let pen = x;
  for (const ch of text) {
    const g = glyphFor(font, ch);
    if (!g) continue;
    const top = baseline - (g.yoff + g.height) * scale;
    for (let gy = 0; gy < g.height; gy++)
      for (let gx = 0; gx < g.width; gx++) {
        if (!g.rows[gy]![gx]) continue;
        bmp.fillRect(pen + (g.xoff + gx) * scale, top + gy * scale, scale, scale, ink);
      }
    pen += g.advance * scale;
  }
  return pen - x;
}

export function drawTextCentered(
  bmp: Bitmap,
  font: BdfFont,
  text: string,
  cx: number,
  y: number,
  ink: Ink = 1,
  scale = 1,
): void {
  drawText(bmp, font, text, Math.round(cx - measureText(font, text, scale) / 2), y, ink, scale);
}

const NO_LINE_START = new Set("，。、！？；：）》」』】,.!?;:)%°…~");

/** Wraps text to `maxWidth`. CJK breaks per character, ASCII runs stay whole when possible. */
export function wrapText(font: BdfFont, text: string, maxWidth: number): string[] {
  const tokens = text.match(/[A-Za-z0-9°.%:~+\-/]+|\s+|./gu) ?? [];
  const lines: string[] = [];
  let cur = "";
  for (const raw of tokens) {
    if (/^\s+$/.test(raw)) {
      if (cur) cur += " ";
      continue;
    }
    const tok = raw;
    if (measureText(font, cur + tok) <= maxWidth) {
      cur += tok;
      continue;
    }
    if (measureText(font, tok) > maxWidth) {
      for (const ch of tok) {
        if (measureText(font, cur + ch) > maxWidth && cur) {
          lines.push(cur.trimEnd());
          cur = "";
        }
        cur += ch;
      }
      continue;
    }
    if (NO_LINE_START.has(tok) && [...cur].length > 1) {
      const chars = [...cur];
      const carry = chars.pop()!;
      lines.push(chars.join("").trimEnd());
      cur = carry + tok;
      continue;
    }
    if (cur.trim()) lines.push(cur.trimEnd());
    cur = tok;
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines;
}
