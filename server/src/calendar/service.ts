import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config } from "../config.js";
import type { BdfFont } from "./bdf.js";
import { ensureFonts, loadFont } from "./fonts.js";
import { generate } from "./pipeline.js";
import { SceneRenderer } from "./render/runner.js";

/** Name tag of scheduled outputs; only these are pruned by CALENDAR_KEEP. */
const JOB_NAME = "auto";

export interface CalendarStatus {
  running: boolean;
  runStartedAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  nextRunAt: string | null;
  intervalMin: number;
  latest: string | null;
}

export interface CalendarOutput {
  name: string;
  generatedAt: string;
  jobName: string;
}

const log = (msg: string) => console.log(`[calendar ${new Date().toLocaleTimeString()}] ${msg}`);

/** Next wall-clock slot aligned to the interval, counted from local midnight (60 -> every full hour). */
export function nextSlot(from: Date, intervalMin: number): Date {
  const midnight = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const step = intervalMin * 60_000;
  const k = Math.floor((from.getTime() - midnight.getTime()) / step) + 1;
  return new Date(midnight.getTime() + k * step);
}

/** Scheduled AI calendar generation and the outputs it has written. */
export class CalendarService {
  readonly outputDir: string;
  private font: BdfFont | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private runStartedAt: string | null = null;
  private lastRunAt: string | null = null;
  private lastError: string | null = null;
  private nextRunAt: string | null = null;

  constructor(private readonly cfg: Config) {
    this.outputDir = cfg.calendar.outputDir;
  }

  /** Output dirs sorted newest first by meta.generatedAt. */
  outputs(): CalendarOutput[] {
    const root = this.outputDir;
    if (!existsSync(root)) return [];
    const list: CalendarOutput[] = [];
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const metaPath = join(root, d.name, "meta.json");
      if (!existsSync(metaPath) || !existsSync(join(root, d.name, "ticker.json"))) continue;
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf8"));
        list.push({ name: d.name, generatedAt: String(meta.generatedAt), jobName: String(meta.name) });
      } catch {
        // A run that is still being written; skip it.
      }
    }
    return list.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  }

  private prune(): void {
    if (this.cfg.calendar.keep <= 0) return;
    const stale = this.outputs().filter((o) => o.jobName === JOB_NAME).slice(this.cfg.calendar.keep);
    for (const o of stale) {
      rmSync(join(this.outputDir, o.name), { recursive: true, force: true });
      log(`pruned ${o.name}`);
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Generate one frame now; returns false when a run is already in progress. */
  trigger(): boolean {
    if (this.running) return false;
    void this.runOnce();
    return true;
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.runStartedAt = new Date().toISOString();
    log("generating...");
    // A fresh browser per run, so a crashed or leaking Chromium never outlives one job.
    let renderer: SceneRenderer | null = null;
    try {
      if (!this.font) {
        await ensureFonts(false);
        this.font = loadFont();
      }
      renderer = await SceneRenderer.launch();
      const dir = await generate(this.cfg, renderer, this.font, {
        name: JOB_NAME,
        date: new Date(),
        dither: "atkinson",
        scale: 2,
        useLlm: true,
      });
      this.lastError = null;
      log(`done -> ${basename(dir)}`);
      this.prune();
    } catch (err) {
      this.lastError = (err as Error).message.split("\n")[0]!;
      log(`failed: ${this.lastError}`);
    } finally {
      await renderer?.close().catch(() => {});
      this.running = false;
      this.lastRunAt = new Date().toISOString();
    }
  }

  start(): void {
    if (this.cfg.calendar.runOnStart) void this.runOnce();
    const schedule = () => {
      const at = nextSlot(new Date(), this.cfg.calendar.intervalMin);
      this.nextRunAt = at.toISOString();
      this.timer = setTimeout(() => void this.runOnce().finally(schedule), at.getTime() - Date.now());
    };
    schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  status(): CalendarStatus {
    return {
      running: this.running,
      runStartedAt: this.runStartedAt,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      nextRunAt: this.nextRunAt,
      intervalMin: this.cfg.calendar.intervalMin,
      latest: this.outputs()[0]?.name ?? null,
    };
  }
}
