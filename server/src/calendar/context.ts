import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Solar } from "lunar-javascript";

export const WEATHER_KINDS = ["clear", "cloudy", "overcast", "fog", "drizzle", "rain", "snow", "thunder"] as const;
export type WeatherKind = (typeof WEATHER_KINDS)[number];

const WEATHER_ZH: Record<WeatherKind, string> = {
  clear: "晴",
  cloudy: "多云",
  overcast: "阴",
  fog: "雾",
  drizzle: "小雨",
  rain: "雨",
  snow: "雪",
  thunder: "雷雨",
};

const WEEKDAY_EN = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const SOLAR_FESTIVALS: Record<string, string> = {
  "1-1": "元旦",
  "2-14": "情人节",
  "3-8": "妇女节",
  "4-1": "愚人节",
  "5-1": "劳动节",
  "5-4": "青年节",
  "6-1": "儿童节",
  "9-10": "教师节",
  "10-1": "国庆节",
  "10-31": "万圣夜",
  "12-24": "平安夜",
  "12-25": "圣诞节",
};

export interface Weather {
  kind: WeatherKind;
  text: string;
  temp: number | null;
  tempMin: number | null;
  tempMax: number | null;
  source: "open-meteo" | "cache" | "override" | "unavailable";
}

export interface CalendarContext {
  iso: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  time: string;
  dateText: string;
  weekdayZh: string;
  weekdayEn: string;
  isWeekend: boolean;
  dayPeriod: string;
  isNight: boolean;
  lunarDate: string;
  lunarYear: string;
  solarTerm: string | null;
  nextSolarTerm: { name: string; date: string; daysLeft: number };
  festivals: string[];
  city: string;
  weather: Weather;
  /** Headline shown in the inverted inset box of the info card. */
  highlight: { title: string; subtitle: string };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function dayPeriod(hour: number): string {
  if (hour < 5) return "深夜";
  if (hour < 8) return "清晨";
  if (hour < 11) return "上午";
  if (hour < 13) return "中午";
  if (hour < 17) return "下午";
  if (hour < 19) return "傍晚";
  if (hour < 23) return "夜晚";
  return "深夜";
}

function daysBetween(a: Date, ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  const start = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  return Math.round((Date.UTC(y!, m! - 1, d!) - start) / 86400000);
}

/** Calendar facts for a local date; weather is attached separately. */
export function buildCalendar(date: Date, city: string, weather: Weather): CalendarContext {
  const solar = Solar.fromYmdHms(
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    0,
  );
  const lunar = solar.getLunar();
  const solarTerm = lunar.getJieQi() || null;
  const next = lunar.getNextJieQi(true);
  const nextSolarTerm = {
    name: next.getName(),
    date: next.getSolar().toYmd(),
    daysLeft: daysBetween(date, next.getSolar().toYmd()),
  };
  const solarFest = SOLAR_FESTIVALS[`${date.getMonth() + 1}-${date.getDate()}`];
  const festivals = [...lunar.getFestivals(), ...(solarFest ? [solarFest] : [])];
  const hour = date.getHours();
  const weekday = date.getDay();
  const lunarDate = `${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`;
  const lunarYear = `${lunar.getYearInGanZhi()}${lunar.getYearShengXiao()}年`;

  let highlight: CalendarContext["highlight"];
  if (festivals.length > 0)
    highlight = { title: festivals[0]!, subtitle: solarTerm ? `今日${solarTerm}` : lunarYear };
  else if (solarTerm) highlight = { title: solarTerm, subtitle: "二十四节气" };
  else highlight = { title: `距${nextSolarTerm.name}`, subtitle: `还有 ${nextSolarTerm.daysLeft} 天` };

  return {
    iso: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(hour)}:${pad(date.getMinutes())}`,
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour,
    minute: date.getMinutes(),
    time: `${pad(hour)}:${pad(date.getMinutes())}`,
    dateText: `${pad(date.getMonth() + 1)}.${pad(date.getDate())}`,
    weekdayZh: `周${solar.getWeekInChinese()}`,
    weekdayEn: WEEKDAY_EN[weekday]!,
    isWeekend: weekday === 0 || weekday === 6,
    dayPeriod: dayPeriod(hour),
    isNight: hour < 6 || hour >= 18,
    lunarDate,
    lunarYear,
    solarTerm,
    nextSolarTerm,
    festivals,
    city,
    weather,
    highlight,
  };
}

/** WMO weather interpretation codes used by Open-Meteo. */
export function weatherKindFromWmo(code: number): WeatherKind {
  if (code === 0 || code === 1) return "clear";
  if (code === 2) return "cloudy";
  if (code === 3) return "overcast";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "thunder";
  return "cloudy";
}

export function weatherOverride(kind: WeatherKind, temp?: number): Weather {
  const t = temp ?? { snow: -2, thunder: 29, rain: 14, drizzle: 15, fog: 10, clear: 20, cloudy: 18, overcast: 16 }[kind];
  return { kind, text: WEATHER_ZH[kind], temp: t, tempMin: t - 4, tempMax: t + 3, source: "override" };
}

export interface FetchWeatherOptions {
  /** Last good reading is stored here and reused while the API is unreachable. */
  cachePath?: string;
  cacheMaxAgeMs?: number;
  attempts?: number;
  timeoutMs?: number;
}

async function requestWeather(lat: number, lon: number, timeoutMs: number): Promise<Weather> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    "&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min" +
    "&timezone=auto&forecast_days=1";
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as {
    current: { temperature_2m: number; weather_code: number };
    daily: { temperature_2m_max: number[]; temperature_2m_min: number[] };
  };
  const kind = weatherKindFromWmo(j.current.weather_code);
  return {
    kind,
    text: WEATHER_ZH[kind],
    temp: Math.round(j.current.temperature_2m),
    tempMin: Math.round(j.daily.temperature_2m_min[0]!),
    tempMax: Math.round(j.daily.temperature_2m_max[0]!),
    source: "open-meteo",
  };
}

const errText = (err: unknown): string => {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  const cause = e.cause?.code ?? e.cause?.message;
  return cause ? `${e.message} (${cause})` : e.message;
};

export async function fetchWeather(lat: number, lon: number, opts: FetchWeatherOptions = {}): Promise<Weather> {
  const { cachePath, cacheMaxAgeMs = 3 * 3600_000, attempts = 3, timeoutMs = 10_000 } = opts;
  let lastError = "";
  for (let i = 1; i <= attempts; i++) {
    try {
      const w = await requestWeather(lat, lon, timeoutMs);
      if (cachePath) {
        mkdirSync(dirname(cachePath), { recursive: true });
        writeFileSync(cachePath, JSON.stringify({ at: Date.now(), lat, lon, weather: w }));
      }
      return w;
    } catch (err) {
      lastError = errText(err);
      console.warn(`Weather attempt ${i}/${attempts} failed: ${lastError}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  if (cachePath && existsSync(cachePath)) {
    try {
      const c = JSON.parse(readFileSync(cachePath, "utf8")) as { at: number; lat: number; lon: number; weather: Weather };
      const age = Date.now() - c.at;
      if (c.lat === lat && c.lon === lon && age <= cacheMaxAgeMs) {
        console.warn(`Weather unavailable, using cached reading from ${Math.round(age / 60_000)} min ago`);
        return { ...c.weather, source: "cache" };
      }
    } catch {
      // Corrupt cache; fall through to the placeholder.
    }
  }
  console.warn(`Weather unavailable: ${lastError}`);
  return { kind: "cloudy", text: WEATHER_ZH.cloudy, temp: null, tempMin: null, tempMax: null, source: "unavailable" };
}

/** Parses `YYYY-MM-DDTHH:mm` as local time in the configured TZ. */
export function parseLocalDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(s);
  if (!m) throw new Error(`Invalid --date "${s}", expected YYYY-MM-DDTHH:mm`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 12), Number(m[5] ?? 0));
}

export function describeContext(c: CalendarContext): string {
  const w = c.weather;
  const temp = w.temp === null ? "气温未知" : `${w.temp}°C（${w.tempMin}~${w.tempMax}°C）`;
  return [
    `日期：${c.year}年${c.month}月${c.day}日 ${c.weekdayZh}${c.isWeekend ? "（周末）" : ""}`,
    `时间：${c.time}，${c.dayPeriod}${c.isNight ? "，天已黑" : "，白天"}`,
    `农历：${c.lunarYear} ${c.lunarDate}`,
    `节气：${c.solarTerm ? `今天是${c.solarTerm}` : `下一个节气是${c.nextSolarTerm.name}，还有${c.nextSolarTerm.daysLeft}天`}`,
    `节日：${c.festivals.length ? c.festivals.join("、") : "无"}`,
    `城市：${c.city}`,
    `天气：${w.text}，${temp}`,
  ].join("\n");
}
