import { type BdfFont, drawText, drawTextCentered, measureText, wrapText } from "./bdf.js";
import { Bitmap } from "./bitmap.js";
import type { CalendarContext } from "./context.js";

export const SCREEN = { width: 400, height: 300 };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const RADIUS = 8;
const PAD = 8;

export const LAYOUT = {
  scene: { x: 6, y: 6, w: 262, h: 288 },
  info: { x: 274, y: 6, w: 120, h: 138 },
  ticker: { x: 274, y: 150, w: 120, h: 144 },
} satisfies Record<string, Rect>;

export const TICKER_VIEWPORT: Rect = {
  x: LAYOUT.ticker.x + PAD,
  y: LAYOUT.ticker.y + PAD,
  w: LAYOUT.ticker.w - 2 * PAD,
  h: LAYOUT.ticker.h - 2 * PAD,
};

const TICKER_LINE_HEIGHT = 15;
const TICKER_GAP = 14;

export interface TickerStrip {
  bitmap: Bitmap;
  entries: { text: string; y: number; height: number; lines: string[] }[];
  lineHeight: number;
  scrolls: boolean;
}

export function tickerEntries(ctx: CalendarContext, literary: string[]): string[] {
  const w = ctx.weather;
  const facts: string[] = [];
  if (ctx.festivals.length) facts.push(`今天是${ctx.festivals.join("、")}`);
  if (ctx.solarTerm) facts.push(`今日${ctx.solarTerm}`);
  else {
    const [, m, d] = ctx.nextSolarTerm.date.split("-").map(Number);
    facts.push(`${m}月${d}日${ctx.nextSolarTerm.name}，还有${ctx.nextSolarTerm.daysLeft}天`);
  }
  if (w.tempMin !== null) facts.push(`${ctx.city}今日${w.text} ${w.tempMin}~${w.tempMax}°C`);
  facts.push(`农历${ctx.lunarYear}${ctx.lunarDate}`);
  return [...literary.map((s) => s.trim()).filter(Boolean), ...facts];
}

/** Renders all ticker entries into one tall strip (white text on black) for vertical scrolling. */
export function renderTickerStrip(font: BdfFont, entries: string[], width = TICKER_VIEWPORT.w): TickerStrip {
  const wrapped = entries.map((text) => ({ text, lines: wrapText(font, text, width) }));
  const textTop = Math.floor((TICKER_LINE_HEIGHT - font.lineHeight) / 2);
  let height = 0;
  for (const e of wrapped) height += e.lines.length * TICKER_LINE_HEIGHT + TICKER_GAP;
  const bmp = new Bitmap(width, Math.max(height, 1), 1);
  const out: TickerStrip["entries"] = [];
  let y = 0;
  for (const e of wrapped) {
    const entryY = y;
    for (const line of e.lines) {
      drawText(bmp, font, line, 0, y + textTop, 0);
      y += TICKER_LINE_HEIGHT;
    }
    out.push({ text: e.text, y: entryY, height: y - entryY, lines: e.lines });
    const mid = y + Math.floor(TICKER_GAP / 2) - 1;
    for (const dx of [-6, 0, 6]) bmp.fillRect(Math.floor(width / 2) + dx - 1, mid, 2, 2, 0);
    y += TICKER_GAP;
  }
  return { bitmap: bmp, entries: out, lineHeight: TICKER_LINE_HEIGHT, scrolls: height > TICKER_VIEWPORT.h };
}

/** Pastes a window of the strip (wrapping around) into the ticker viewport. */
export function drawTickerWindow(frame: Bitmap, strip: TickerStrip, offset: number): void {
  const v = TICKER_VIEWPORT;
  const h = strip.bitmap.height;
  for (let y = 0; y < v.h; y++) {
    const sy = strip.scrolls ? (((offset + y) % h) + h) % h : y;
    for (let x = 0; x < v.w; x++) frame.set(v.x + x, v.y + y, sy < h ? strip.bitmap.get(x, sy) : 1);
  }
}

function fitScale(font: BdfFont, text: string, maxWidth: number, preferred: number): number {
  for (let s = preferred; s > 1; s--) if (measureText(font, text, s) <= maxWidth) return s;
  return 1;
}

function drawInfoCard(frame: Bitmap, font: BdfFont, ctx: CalendarContext): void {
  const c = LAYOUT.info;
  const inner = c.w - 2 * PAD;
  const cx = c.x + c.w / 2;
  frame.fillRoundRect(c.x, c.y, c.w, c.h, RADIUS, 0);
  frame.strokeRoundRect(c.x, c.y, c.w, c.h, RADIUS, 1);

  const timeScale = fitScale(font, ctx.time, inner, 3);
  let y = c.y + PAD + 2;
  drawTextCentered(frame, font, ctx.time, cx, y, 1, timeScale);
  y += font.lineHeight * timeScale + 4;

  drawTextCentered(frame, font, `${ctx.dateText} ${ctx.weekdayZh}`, cx, y, 1);
  y += font.lineHeight + 3;

  const w = ctx.weather;
  const temp = w.temp === null ? "" : ` ${w.temp}°C`;
  let weatherLine = `${ctx.city} ${w.text}${temp}`;
  if (measureText(font, weatherLine) > inner) weatherLine = `${w.text}${temp}`;
  drawTextCentered(frame, font, weatherLine, cx, y, 1);

  const box: Rect = { x: c.x + PAD, y: c.y + c.h - PAD - 48, w: inner, h: 48 };
  frame.fillRoundRect(box.x, box.y, box.w, box.h, 4, 1);
  const titleScale = fitScale(font, ctx.highlight.title, box.w - 8, 2);
  const titleH = font.lineHeight * titleScale;
  const blockH = titleH + 3 + font.lineHeight;
  const top = box.y + Math.floor((box.h - blockH) / 2);
  drawTextCentered(frame, font, ctx.highlight.title, cx, top, 0, titleScale);
  drawTextCentered(frame, font, ctx.highlight.subtitle, cx, top + titleH + 3, 0);
}

function drawScenePanel(frame: Bitmap, font: BdfFont, scene: Bitmap, label: string): void {
  const s = LAYOUT.scene;
  frame.blit(scene, s.x, s.y, { w: s.w, h: s.h, clipRadius: RADIUS });
  frame.strokeRoundRect(s.x, s.y, s.w, s.h, RADIUS, 1);

  const tw = measureText(font, label);
  const lw = tw + 10;
  const lh = font.lineHeight + 6;
  const lx = s.x + PAD;
  const ly = s.y + s.h - PAD - lh;
  frame.fillRoundRect(lx - 1, ly - 1, lw + 2, lh + 2, 5, 0);
  frame.fillRoundRect(lx, ly, lw, lh, 4, 1);
  drawText(frame, font, label, lx + 5, ly + 3, 0);
}

export interface Composition {
  frame: Bitmap;
  strip: TickerStrip;
}

export function compose(font: BdfFont, ctx: CalendarContext, scene: Bitmap, ticker: string[]): Composition {
  const frame = new Bitmap(SCREEN.width, SCREEN.height, 0);
  drawScenePanel(frame, font, scene, ctx.lunarDate);
  drawInfoCard(frame, font, ctx);
  const t = LAYOUT.ticker;
  frame.fillRoundRect(t.x, t.y, t.w, t.h, RADIUS, 1);
  const strip = renderTickerStrip(font, tickerEntries(ctx, ticker));
  drawTickerWindow(frame, strip, 0);
  return { frame, strip };
}
