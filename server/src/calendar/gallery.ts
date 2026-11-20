import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Entry {
  dir: string;
  meta: {
    name: string;
    generatedAt: string;
    source: string;
    model: string | null;
    dither: string;
    sceneTitle: string;
    ticker: string[];
    attempts: { ok: boolean; error?: string }[];
    elapsedMs: number;
    context: { iso: string; weekdayZh: string; lunarDate: string; weather: { text: string; temp: number | null }; highlight: { title: string } };
  };
  ticker: { viewport: { x: number; y: number; w: number; h: number }; stripHeight: number; scrolls: boolean; entries: { y: number }[] };
  animation: {
    frames: number;
    fps: number;
    dither: string;
    /** Dithers with their own animation/<dither>/ loop; absent in older outputs. */
    dithers?: string[];
    motionPct: number;
    loopSeamPct: number;
    warning: string | null;
  } | null;
}

const PAGE = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>AI Pixel Calendar Gallery</title>
<style>
  body { margin: 0; padding: 24px; background: #1d1d1f; color: #ddd; font: 14px/1.5 system-ui, sans-serif; }
  h1 { font-size: 18px; margin: 0 0 16px; }
  .bar { display: flex; gap: 16px; align-items: center; margin-bottom: 20px; flex-wrap: wrap; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(820px, 1fr)); gap: 24px; }
  .card { background: #2a2a2d; border-radius: 10px; padding: 16px; }
  .screen { display: block; width: 800px; height: 600px; image-rendering: pixelated; border-radius: 6px; }
  .rlcd .screen { filter: sepia(0.25) contrast(0.82) brightness(0.98); }
  .row { display: flex; gap: 6px; margin: 10px 0 6px; flex-wrap: wrap; }
  button { background: #3a3a3e; color: #ddd; border: 1px solid #555; border-radius: 5px; padding: 3px 10px; cursor: pointer; }
  button.on { background: #ddd; color: #111; }
  .meta { color: #aaa; font-size: 13px; }
  .meta b { color: #eee; }
  .err { color: #e88; font-size: 12px; white-space: pre-wrap; max-height: 80px; overflow: auto; }
  a { color: #8ab4f8; }
</style>
</head>
<body>
<h1>AI Pixel Calendar Gallery</h1>
<div class="bar">
  <label><input type="checkbox" id="rlcd" /> RLCD tint</label>
  <label><input type="checkbox" id="anim" checked /> Play</label>
  <span class="meta">2x nearest-neighbour. Scene loops at its own fps; ticker scrolls 1px / 60ms and pauses at each entry.</span>
</div>
__LIVE__
<div class="grid" id="grid"></div>
<script>
const ENTRIES = __ENTRIES__;
const DITHERS = ["atkinson", "bayer4", "floyd", "threshold"];
const grid = document.getElementById("grid");
const load = (src) => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src; });
const cards = [];

for (const e of ENTRIES) {
  const m = e.meta, c = m.context;
  const card = document.createElement("div");
  card.className = "card";
  const fails = m.attempts.filter((a) => !a.ok && a.error).map((a) => a.error.split("\n")[0]);
  const animated = (e.animation && e.animation.dithers) || [];
  card.innerHTML =
    '<canvas class="screen" width="400" height="300"></canvas>' +
    '<div class="row">' + (e.animation && !animated.length ? '<button data-d="anim">animation</button>' : "") +
    DITHERS.map((d) => '<button data-d="' + d + '">' + d + "</button>").join("") +
    '<button data-d="raw">raw scene</button></div>' +
    (e.animation ? '<div class="meta">loop: ' + e.animation.frames + " frames @ " + e.animation.fps + "fps · " +
      e.animation.dither + " · motion " + e.animation.motionPct + "%/frame · seam " + e.animation.loopSeamPct + "%" +
      (e.animation.warning ? ' · <span style="color:#e88">' + e.animation.warning.replace(/</g, "&lt;") + "</span>" : "") +
      ' · <a href="' + e.dir + '/anim.gif">anim.gif</a></div>' : "") +
    '<div class="meta"><b>' + m.name + "</b> · " + c.iso + " " + c.weekdayZh + " · " + c.lunarDate + " · " +
    c.weather.text + (c.weather.temp === null ? "" : " " + c.weather.temp + "°C") + " · " + c.highlight.title + "</div>" +
    '<div class="meta">「' + m.sceneTitle + "」 " + m.ticker.join(" / ") + "</div>" +
    '<div class="meta">source: ' + m.source + (m.model ? " (" + m.model + ")" : "") + " · attempts: " + m.attempts.length +
    " · " + (m.elapsedMs / 1000).toFixed(1) + "s · " +
    '<a href="' + e.dir + '/scene.js">scene.js</a> · <a href="' + e.dir + '/meta.json">meta.json</a> · ' +
    '<a href="' + e.dir + '/frame.bin">frame.bin</a></div>' +
    (fails.length ? '<div class="err">' + fails.join("\n").replace(/</g, "&lt;") + "</div>" : "");
  grid.appendChild(card);
  const state = { e, card, ctx: card.querySelector("canvas").getContext("2d"), mode: m.dither, base: null, raw: null, strip: null, offset: 0, pause: 40, frames: null, loops: {}, frame: 0 };
  cards.push(state);
  const loadLoop = (folder) => Promise.all(Array.from({ length: e.animation.frames },
    (_, i) => load(e.dir + "/" + folder + "/frame-" + String(i).padStart(2, "0") + ".png")));
  const select = async (d) => {
    state.mode = d;
    card.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.d === d));
    state.frames = null;
    if (d === "raw") state.raw = state.raw || await load(e.dir + "/scene_raw.png");
    else if (d === "anim" || animated.includes(d)) {
      const folder = d === "anim" ? "animation" : "animation/" + d;
      state.loops[d] = state.loops[d] || await loadLoop(folder);
      if (state.mode === d) state.frames = state.loops[d];
    } else state.base = await load(e.dir + "/variants/frame-" + d + ".png");
    draw(state);
  };
  card.querySelectorAll("button").forEach((b) => b.onclick = () => select(b.dataset.d));
  const first = animated.includes(e.animation && e.animation.dither) ? e.animation.dither : e.animation ? "anim" : m.dither;
  load(e.dir + "/ticker.png").then((img) => { state.strip = img; select(first); });
}

function draw(s) {
  const g = s.ctx;
  g.imageSmoothingEnabled = false;
  if (s.mode === "raw") {
    g.fillStyle = "#fff"; g.fillRect(0, 0, 400, 300);
    if (s.raw) g.drawImage(s.raw, 6, 6, 262, 288);
    return;
  }
  const base = s.frames ? s.frames[s.frame] : s.base;
  if (!base) return;
  g.drawImage(base, 0, 0);
  const t = s.e.ticker, v = t.viewport;
  if (!s.strip || !t.scrolls) return;
  const h = t.stripHeight;
  const off = ((s.offset % h) + h) % h;
  const first = Math.min(v.h, h - off);
  g.drawImage(s.strip, 0, off, v.w, first, v.x, v.y, v.w, first);
  if (first < v.h) g.drawImage(s.strip, 0, 0, v.w, v.h - first, v.x, v.y + first, v.w, v.h - first);
}

document.getElementById("rlcd").onchange = (ev) => document.body.classList.toggle("rlcd", ev.target.checked);
setInterval(() => {
  if (!document.getElementById("anim").checked) return;
  for (const s of cards) {
    const t = s.e.ticker;
    if (!t.scrolls || s.mode === "raw") continue;
    if (s.pause > 0) { s.pause--; continue; }
    s.offset = (s.offset + 1) % t.stripHeight;
    if (t.entries.some((en) => en.y === s.offset)) s.pause = 40;
    draw(s);
  }
}, 60);
setInterval(() => {
  if (!document.getElementById("anim").checked) return;
  const now = performance.now();
  for (const s of cards) {
    const a = s.e.animation;
    if (!a || !s.frames) continue;
    const next = Math.floor((now / 1000) * a.fps) % a.frames;
    if (next !== s.frame) { s.frame = next; draw(s); }
  }
}, 50);
</script>
</body>
</html>
`;

const LIVE = String.raw`<div class="bar" id="live">
  <button id="gen">Generate now</button>
  <span class="meta" id="status">connecting...</span>
</div>
<script>
const statusEl = document.getElementById("status");
const genBtn = document.getElementById("gen");
const shown = __LATEST__;
const fmt = (iso) => iso ? new Date(iso).toLocaleString() : "-";
async function poll() {
  try {
    const s = await (await fetch("/api/calendar/status")).json();
    if (s.latest && s.latest !== shown) return location.reload();
    genBtn.disabled = s.running;
    statusEl.innerHTML = (s.running ? "<b>generating...</b> since " + fmt(s.runStartedAt) : "idle") +
      " · every " + s.intervalMin + " min · next " + fmt(s.nextRunAt) + " · last " + fmt(s.lastRunAt) +
      (s.lastError ? ' · <span style="color:#e88">' + s.lastError.replace(/</g, "&lt;") + "</span>" : "") +
      ' · <a href="/calendar/latest/frame.png">/calendar/latest/frame.png</a>' +
      ' · <a href="/calendar/latest/frame.bin">/calendar/latest/frame.bin</a> · <a href="/">home</a>';
  } catch { statusEl.textContent = "server unreachable"; }
}
genBtn.onclick = async () => { genBtn.disabled = true; await fetch("/api/calendar/generate", { method: "POST" }); poll(); };
poll();
setInterval(poll, 5000);
</script>`;

export interface GalleryOptions {
  /** Show only the newest N outputs. */
  limit?: number;
  /** Add the status bar and auto-reload used by the local server. */
  live?: boolean;
}

export function galleryHtml(outputDir: string, opts: GalleryOptions = {}): string {
  const entries: Entry[] = [];
  if (existsSync(outputDir))
    for (const dir of readdirSync(outputDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const base = join(outputDir, dir.name);
      if (!existsSync(join(base, "meta.json")) || !existsSync(join(base, "ticker.json"))) continue;
      entries.push({
        dir: encodeURI(dir.name),
        meta: JSON.parse(readFileSync(join(base, "meta.json"), "utf8")),
        ticker: JSON.parse(readFileSync(join(base, "ticker.json"), "utf8")),
        animation: existsSync(join(base, "animation.json"))
          ? JSON.parse(readFileSync(join(base, "animation.json"), "utf8"))
          : null,
      });
    }
  entries.sort((a, b) => b.meta.generatedAt.localeCompare(a.meta.generatedAt));
  const slim = entries.slice(0, opts.limit ?? entries.length).map((e) => ({
    dir: e.dir,
    ticker: e.ticker,
    animation: e.animation,
    meta: { ...e.meta, prompt: undefined, rawReplies: undefined },
  }));
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
  const live = opts.live ? LIVE.replace("__LATEST__", json(entries[0] ? decodeURI(entries[0].dir) : null)) : "";
  return PAGE.replace("__LIVE__", () => live).replace("__ENTRIES__", () => json(slim));
}

export function buildGallery(outputDir: string): string {
  const path = join(outputDir, "gallery.html");
  writeFileSync(path, galleryHtml(outputDir));
  return path;
}
