import { join } from "node:path";
import { type BdfFont, missingGlyphs } from "./bdf.js";
import type { Bitmap } from "./bitmap.js";
import { type Config } from "../config.js";
import { type CalendarContext, type Weather, buildCalendar, fetchWeather } from "./context.js";
import { writeBin, writeBitmapPng, writeBytes, writeJson, writeRgbaPng, writeText } from "./export.js";
import { fallbackScene } from "./fallback-scene.js";
import { compose, LAYOUT, TICKER_VIEWPORT } from "./layout.js";
import { encodeGif } from "./gif.js";
import {
  ANIMATION,
  type ChatMessage,
  chat,
  parseSceneReply,
  SCENE_SIZE,
  type SceneReply,
  SYSTEM_PROMPT,
  userPrompt,
} from "./llm.js";
import {
  type AnimationStats,
  animationProblem,
  animationStats,
  DITHERS,
  type Dither,
  pixelate,
  pixelateFrames,
  type PixelateResult,
  sceneProblem,
} from "./pixelate.js";
import type { SceneRenderer } from "./render/runner.js";

export interface GenerateOptions {
  name: string;
  date: Date;
  weather?: Weather;
  dither: Dither;
  scale: number;
  useLlm: boolean;
  seed?: number;
  /** Re-use an earlier reply instead of calling the LLM (see `recompose`). */
  reply?: SceneReply;
  /** Model that produced `reply`, recorded in meta.json. */
  model?: string | null;
}

interface Attempt {
  attempt: number;
  ok: boolean;
  error?: string;
  llmMs?: number;
  renderMs?: number;
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  return h >>> 0;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * Ordered dithering keeps static areas pixel-identical between frames, so it
 * is the reference for the loop checks and the device's default mode.
 */
const ANIM_DITHER: Dither = "bayer4";

interface Rendered {
  rgba: Uint8Array;
  pix: PixelateResult;
  renderW: number;
  renderH: number;
  /** One scene bitmap per animation frame (t = i / frames), dithered with ANIM_DITHER. */
  anim: Bitmap[];
  /** The same loop for every dither. */
  anims: Record<Dither, Bitmap[]>;
  animStats: AnimationStats;
  /** Set when the animation is usable as a still but fails the loop/motion checks. */
  animWarning: string | null;
}

async function renderAndCheck(
  renderer: SceneRenderer,
  reply: SceneReply,
  ctx: CalendarContext,
  opts: GenerateOptions,
  seed: number,
  strictAnimation: boolean,
): Promise<Rendered | { error: string }> {
  const renderW = Math.ceil(SCENE_SIZE.width / opts.scale);
  const renderH = Math.ceil(SCENE_SIZE.height / opts.scale);
  const n = ANIMATION.frames;
  const res = await renderer.render({
    code: reply.scene_js,
    width: renderW,
    height: renderH,
    seed,
    ts: Array.from({ length: n + 1 }, (_, i) => i / n),
    ctx: {
      weather: { kind: ctx.weather.kind },
      isNight: ctx.isNight,
      hour: ctx.hour,
      solarTerm: ctx.solarTerm,
      festivals: ctx.festivals,
      dayPeriod: ctx.dayPeriod,
    },
  });
  if (!res.ok) return { error: `scene_js failed to run: ${res.error}` };
  const rgba = res.frames[0]!;
  const { width: sw, height: sh } = SCENE_SIZE;
  const pix = pixelate(rgba, renderW, renderH, opts.scale, sw, sh, opts.dither);
  const problem = sceneProblem(pix);
  if (problem) return { error: problem };
  const all = pixelateFrames(res.frames, renderW, renderH, opts.scale, sw, sh, ANIM_DITHER, pix.levels);
  const anim = all.slice(0, n);
  const animStats = animationStats(anim, all[n]!);
  const animWarning = animationProblem(animStats);
  if (animWarning && strictAnimation) return { error: animWarning };
  const loop = res.frames.slice(0, n);
  const anims = Object.fromEntries(
    DITHERS.map((algo) => [
      algo,
      algo === ANIM_DITHER ? anim : pixelateFrames(loop, renderW, renderH, opts.scale, sw, sh, algo, pix.levels),
    ]),
  ) as Record<Dither, Bitmap[]>;
  return { rgba, pix, renderW, renderH, anim, anims, animStats, animWarning };
}

export async function generate(
  cfg: Config,
  renderer: SceneRenderer,
  font: BdfFont,
  opts: GenerateOptions,
): Promise<string> {
  const started = Date.now();
  const weather =
    opts.weather ??
    (await fetchWeather(cfg.city.lat, cfg.city.lon, { cachePath: cfg.calendar.weatherCachePath }));
  const ctx = buildCalendar(opts.date, cfg.city.name, weather);
  const seed = opts.seed ?? hashSeed(`${ctx.iso.slice(0, 10)}|${ctx.weather.kind}|${ctx.hour}`);
  const log = (msg: string) => console.log(`[${opts.name}] ${msg}`);

  const attempts: Attempt[] = [];
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt(ctx) },
  ];
  let reply: SceneReply | null = null;
  let rendered: Rendered | null = null;
  const rawReplies: string[] = [];
  let source: "llm" | "fallback" | "reused" = "fallback";

  if (opts.reply) {
    const r = await renderAndCheck(renderer, opts.reply, ctx, opts, seed, false);
    if ("error" in r) log(`reused scene failed: ${r.error.split("\n")[0]}`);
    else {
      reply = opts.reply;
      rendered = r;
      source = "reused";
    }
  } else if (opts.useLlm && cfg.llm.apiKey) {
    for (let i = 0; i <= cfg.llm.maxRetries && !rendered; i++) {
      const a: Attempt = { attempt: i + 1, ok: false };
      attempts.push(a);
      try {
        log(`LLM attempt ${i + 1} (${cfg.llm.model})...`);
        const t0 = Date.now();
        const text = await chat(cfg.llm, messages);
        a.llmMs = Date.now() - t0;
        rawReplies.push(text);
        messages.push({ role: "assistant", content: text });
        const candidate = parseSceneReply(text);
        const t1 = Date.now();
        // On the last attempt a still image beats the fallback, so animation problems only warn.
        const r = await renderAndCheck(renderer, candidate, ctx, opts, seed, i < cfg.llm.maxRetries);
        a.renderMs = Date.now() - t1;
        if ("error" in r) throw new Error(r.error);
        a.ok = true;
        reply = candidate;
        rendered = r;
        source = "llm";
      } catch (err) {
        a.error = (err as Error).message;
        log(`attempt ${i + 1} failed: ${a.error.split("\n")[0]}`);
        if (messages.at(-1)?.role === "assistant")
          messages.push({
            role: "user",
            content: `上一版有问题：${a.error.slice(0, 800)}\n请修正后重新输出完整的 json。`,
          });
      }
    }
  } else {
    log(opts.useLlm ? "LLM_API_KEY not set, using fallback scene" : "--no-llm, using fallback scene");
  }

  if (!rendered) {
    reply = fallbackScene(ctx);
    const r = await renderAndCheck(renderer, reply, ctx, opts, seed, false);
    if ("error" in r) throw new Error(`fallback scene failed: ${r.error}`);
    rendered = r;
    source = "fallback";
  }
  reply = reply!;

  const dir = join(cfg.calendar.outputDir, `${stamp(opts.date)}_${opts.name}_${Date.now().toString(36)}`);
  const { frame, strip } = compose(font, ctx, rendered.pix.bitmap, reply.ticker);
  const missing = missingGlyphs(font, strip.entries.map((e) => e.text).join("") + ctx.highlight.title + ctx.highlight.subtitle);
  if (missing.length) log(`missing glyphs rendered as '?': ${missing.join(" ")}`);
  writeBitmapPng(join(dir, "frame.png"), frame);
  writeBitmapPng(join(dir, "preview@3x.png"), frame, 3);
  writeBin(join(dir, "frame.bin"), frame);
  writeBitmapPng(join(dir, "ticker.png"), strip.bitmap);
  writeJson(join(dir, "ticker.json"), {
    viewport: TICKER_VIEWPORT,
    stripHeight: strip.bitmap.height,
    lineHeight: strip.lineHeight,
    scrolls: strip.scrolls,
    entries: strip.entries,
  });
  writeRgbaPng(join(dir, "scene_raw.png"), rendered.rgba, rendered.renderW, rendered.renderH, opts.scale);
  writeText(join(dir, "scene.js"), reply.scene_js);

  for (const algo of DITHERS) {
    const pix =
      algo === opts.dither
        ? rendered.pix
        : pixelate(rendered.rgba, rendered.renderW, rendered.renderH, opts.scale, SCENE_SIZE.width, SCENE_SIZE.height, algo);
    writeBitmapPng(join(dir, "variants", `frame-${algo}.png`), compose(font, ctx, pix.bitmap, reply.ticker).frame);
  }

  if (rendered.animWarning) log(`animation warning: ${rendered.animWarning}`);
  const tickerLines = reply.ticker;
  const animFrames = rendered.anim.map((scene, i) => {
    const f = compose(font, ctx, scene, tickerLines).frame;
    const id = String(i).padStart(2, "0");
    writeBitmapPng(join(dir, "animation", `frame-${id}.png`), f);
    writeBin(join(dir, "animation", `scene-${id}.bin`), scene);
    return f;
  });
  writeBytes(join(dir, "anim.gif"), encodeGif(animFrames, ANIMATION.fps, 2));
  for (const algo of DITHERS)
    rendered.anims[algo].forEach((scene, i) => {
      const id = String(i).padStart(2, "0");
      writeBitmapPng(join(dir, "animation", algo, `frame-${id}.png`), compose(font, ctx, scene, tickerLines).frame);
    });
  const pct = (v: number) => Number((v * 100).toFixed(3));
  writeJson(join(dir, "animation.json"), {
    frames: ANIMATION.frames,
    fps: ANIMATION.fps,
    dither: ANIM_DITHER,
    dithers: DITHERS,
    sceneRect: LAYOUT.scene,
    sceneBin: { width: SCENE_SIZE.width, height: SCENE_SIZE.height, stride: Math.ceil(SCENE_SIZE.width / 8) },
    motionPct: pct(rendered.animStats.motion),
    maxStepPct: pct(rendered.animStats.maxStep),
    loopSeamPct: pct(rendered.animStats.loopSeam),
    warning: rendered.animWarning,
  });

  writeJson(join(dir, "meta.json"), {
    name: opts.name,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    source,
    model: source === "fallback" ? null : (opts.model ?? cfg.llm.model),
    dither: opts.dither,
    pixelScale: opts.scale,
    seed,
    sceneTitle: reply.scene_title,
    ticker: reply.ticker,
    inkRatio: Number(rendered.pix.inkRatio.toFixed(3)),
    missingGlyphs: missing,
    animationWarning: rendered.animWarning,
    context: ctx,
    attempts,
    prompt: { system: SYSTEM_PROMPT, user: userPrompt(ctx) },
    rawReplies,
  });
  log(`done (${source}, ${((Date.now() - started) / 1000).toFixed(1)}s) -> ${dir}`);
  return dir;
}
