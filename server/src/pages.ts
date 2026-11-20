import type { CalendarStatus } from "./calendar/service.js";
import type { TrendingStatus } from "./trending/service.js";
import type { RankedModel, TrendingState } from "./trending/trending.js";

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const time = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "-";

const STYLE = `
  body { margin: 0; padding: 24px; background: #1d1d1f; color: #ddd; font: 14px/1.6 system-ui, sans-serif; }
  h1 { font-size: 18px; margin: 0 0 16px; } h2 { font-size: 16px; margin: 0 0 8px; }
  .card { background: #2a2a2d; border-radius: 10px; padding: 16px; margin-bottom: 16px; max-width: 980px; }
  .meta { color: #aaa; font-size: 13px; } .err { color: #e88; } .ok { color: #8c8; }
  a { color: #8ab4f8; } code { color: #eee; }
  button { background: #3a3a3e; color: #ddd; border: 1px solid #555; border-radius: 5px; padding: 3px 10px; cursor: pointer; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #3a3a3e; }
  th { color: #aaa; font-weight: normal; } td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .UP { color: #8c8; } .DN { color: #e88; } .NEW { color: #8ab4f8; }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><title>${esc(title)}</title>` +
    `<style>${STYLE}</style></head><body>${body}</body></html>`;
}

const post = (url: string, label: string) =>
  `<button onclick="this.disabled=true;fetch('${url}',{method:'POST'}).then(()=>setTimeout(()=>location.reload(),1500))">${esc(label)}</button>`;

export function indexPage(t: TrendingStatus, c: CalendarStatus, city: string): string {
  const trendingState = t.refreshing
    ? "刷新中"
    : t.fetchedAt
      ? `<span class="${t.stale ? "err" : "ok"}">${t.stale ? "STALE" : "OK"}</span> · 抓取于 ${time(t.fetchedAt)}`
      : "尚无快照";
  const calendarState = c.running ? `生成中（开始于 ${time(c.runStartedAt)}）` : "空闲";
  return page(
    "Pixel Monitor Backend",
    `<h1>Pixel Monitor Backend</h1>
<div class="card"><h2><a href="/trending">HF Trending</a></h2>
  <div>${trendingState} · 每 ${t.refreshMin} 分钟 · 下次 ${time(t.nextRefreshAt)} · 来源 <code>${esc(t.source)}</code></div>
  ${t.lastError ? `<div class="err">${esc(t.lastError)}</div>` : ""}
  <div class="meta">设备接口 <a href="/api/trending.tsv">/api/trending.tsv</a> · ${post("/api/trending/refresh", "立即刷新")}</div>
</div>
<div class="card"><h2><a href="/calendar/">AI Calendar</a></h2>
  <div>${calendarState} · ${esc(city)} · 每 ${c.intervalMin} 分钟 · 下次 ${time(c.nextRunAt)} · 上次 ${time(c.lastRunAt)}</div>
  ${c.lastError ? `<div class="err">${esc(c.lastError)}</div>` : ""}
  <div class="meta">最新 <a href="/calendar/latest/frame.png">frame.png</a> · <a href="/calendar/latest/frame.bin">frame.bin</a> ·
    <a href="/calendar/latest/anim.gif">anim.gif</a> · ${c.latest ? esc(c.latest) : "尚无输出"} · ${post("/api/calendar/generate", "立即生成")}</div>
</div>
<div class="meta"><a href="/api/status">/api/status</a> · <a href="/healthz">/healthz</a></div>`,
  );
}

const movement = (m: RankedModel): string =>
  m.movement === "UP" ? `UP ${m.rankDelta}` : m.movement === "DN" ? `DN ${-m.rankDelta}` : m.movement === "NEW" ? "NEW" : "--";

const compact = (n: number | null): string => {
  if (n === null) return "-";
  for (const [v, s] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]] as const)
    if (n >= v) return `${(n / v).toFixed(1).replace(/\.0$/, "")}${s}`;
  return String(n);
};

export function trendingPage(state: TrendingState | null, t: TrendingStatus): string {
  const rows = (state?.models ?? [])
    .map(
      (m) => `<tr><td class="num">${m.rank}</td><td class="${m.movement}">${movement(m)}</td>` +
        `<td><a href="https://huggingface.co/${esc(m.modelId)}">${esc(m.modelId)}</a></td><td>${esc(m.pipeline)}</td>` +
        `<td class="num">${compact(m.parameters)}</td><td class="num">${compact(m.downloads)}</td>` +
        `<td class="num">${compact(m.likes)}</td><td>${time(m.updatedAt || null)}</td></tr>`,
    )
    .join("");
  return page(
    "HF Trending",
    `<h1><a href="/">Home</a> / HF Trending</h1>
<div class="card">
  <div>${state ? `<span class="${state.stale ? "err" : "ok"}">${state.stale ? "STALE" : "OK"}</span> · 抓取于 ${time(state.fetchedAt)} · 对比 ${time(state.previousFetchedAt)}` : "尚无快照"}
    · ${post("/api/trending/refresh", "立即刷新")}</div>
  ${t.lastError ? `<div class="err">${esc(t.lastError)}</div>` : ""}
  <div class="meta">名次变化相对上一次快照；手动刷新也会推进基线。来源 <code>${esc(t.source)}</code> · <a href="/api/trending.tsv">TSV</a></div>
</div>
<div class="card"><table>
  <tr><th>#</th><th>变化</th><th>模型</th><th>任务</th><th>参数</th><th>下载</th><th>点赞</th><th>更新</th></tr>
  ${rows || '<tr><td colspan="8" class="meta">暂无数据</td></tr>'}
</table></div>`,
  );
}
