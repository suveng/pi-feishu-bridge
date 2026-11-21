/**
 * 定时任务的时间表达式：cron 五段 / 固定间隔 / 一次性时刻。
 *
 * 纯函数、无 IO —— 解析与「下一次触发时刻」的计算都收在这里，便于单测。
 * 所有时刻按**本机时区**算：daemon 跑在用户机器上，用户说的「每天 9 点」就是本机 9 点。
 */

export type ScheduleKind = "cron" | "every" | "once";

export type CronSpec = {
  /** 用户原样输入（展示用） */
  source: string;
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  /** 日 / 周是否被显式限定（Vixie cron：两者都限定时取「或」） */
  domRestricted: boolean;
  dowRestricted: boolean;
};

/** 向后搜索的天花板：4 年，足以跨过 2 月 29 日 */
const MAX_SEARCH_DAYS = 1461;
/** 间隔型任务的下限：再密就是刷屏（也是飞书消息频率的红线） */
export const MIN_EVERY_MS = 60_000;

export type ScheduleSpecResult =
  | { ok: true; kind: "cron"; cron: string; description: string }
  | { ok: true; kind: "every"; everyMs: number; description: string }
  | { ok: true; kind: "once"; at: number; description: string }
  | { ok: false; error: string };

function range(min: number, max: number): number[] {
  const out: number[] = [];
  for (let v = min; v <= max; v += 1) out.push(v);
  return out;
}

type ParsedField = { values: number[]; restricted: boolean };

/**
 * 单个 cron 字段：支持 `*` `?` `n` `a-b` `*\/n` `a-b/n` `a/n` 与逗号列表。
 * `restricted=false` 只对整段 `*`/`?` 成立 —— 它决定日/周的「或」还是「与」。
 */
function parseField(raw: string, min: number, max: number, label: string): ParsedField {
  const text = raw.trim();
  if (text === "*" || text === "?") return { values: range(min, max), restricted: false };
  const values = new Set<number>();
  for (const chunk of text.split(",")) {
    const seg = chunk.trim();
    if (!seg) throw new Error(`${label}字段有空项：${raw}`);
    const stepMatch = seg.match(/^(.+?)\/(\d+)$/);
    let step = 1;
    let body = seg;
    if (stepMatch) {
      body = stepMatch[1].trim();
      step = Number.parseInt(stepMatch[2], 10);
      if (!Number.isFinite(step) || step <= 0) throw new Error(`${label}字段的步长非法：${seg}`);
    }
    if (body === "*" || body === "?") {
      for (let v = min; v <= max; v += step) values.add(v);
      continue;
    }
    const rangeMatch = body.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10);
      const end = Number.parseInt(rangeMatch[2], 10);
      if (start > end) throw new Error(`${label}字段的区间反了：${seg}`);
      for (let v = start; v <= end; v += step) values.add(v);
      continue;
    }
    if (/^\d+$/.test(body)) {
      const v = Number.parseInt(body, 10);
      values.add(v);
      // `a/n` 表示「从 a 起每 n 个」，不是只取 a
      if (stepMatch) for (let x = v; x <= max; x += step) values.add(x);
      continue;
    }
    throw new Error(`${label}字段无法解析：${seg}`);
  }
  for (const v of values) {
    if (v < min || v > max) throw new Error(`${label}字段取值越界：${v}（允许 ${min}-${max}）`);
  }
  return { values: Array.from(values).sort((a, b) => a - b), restricted: true };
}

export function parseCron(expr: string): CronSpec {
  const source = expr.trim().replace(/\s+/g, " ");
  const parts = source.split(" ");
  if (parts.length !== 5) {
    throw new Error(`cron 需要 5 段（分 时 日 月 周），收到 ${parts.length} 段：${source}`);
  }
  const minutes = parseField(parts[0], 0, 59, "分");
  const hours = parseField(parts[1], 0, 23, "时");
  const dom = parseField(parts[2], 1, 31, "日");
  const month = parseField(parts[3], 1, 12, "月");
  const dow = parseField(parts[4], 0, 7, "周");
  return {
    source,
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: dom.values,
    months: month.values,
    // cron 里 0 与 7 都表示周日，统一成 0，否则 getDay() 永远匹配不上 7
    daysOfWeek: Array.from(new Set(dow.values.map((v) => (v === 7 ? 0 : v)))).sort((a, b) => a - b),
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted,
  };
}

function dayMatches(spec: CronSpec, d: Date): boolean {
  const domHit = spec.daysOfMonth.includes(d.getDate());
  const dowHit = spec.daysOfWeek.includes(d.getDay());
  // Vixie cron 的经典语义：日、周都被限定时取「或」，只限定一个时就是那个条件
  if (spec.domRestricted && spec.dowRestricted) return domHit || dowHit;
  if (spec.domRestricted) return domHit;
  if (spec.dowRestricted) return dowHit;
  return true;
}

/**
 * 严格晚于 `fromMs` 的下一个触发时刻（毫秒）。
 * 按天推进 + 只在命中日期时遍历时/分，最坏 4 年 × 十几个候选，不会退化成逐分钟扫描。
 */
export function nextCronTime(spec: CronSpec, fromMs: number): number | undefined {
  const start = new Date(fromMs);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const startMs = start.getTime();
  const base = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  for (let i = 0; i < MAX_SEARCH_DAYS; i += 1) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    if (!spec.months.includes(day.getMonth() + 1)) continue;
    if (!dayMatches(spec, day)) continue;
    for (const h of spec.hours) {
      for (const m of spec.minutes) {
        const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0).getTime();
        if (t >= startMs) return t;
      }
    }
  }
  return undefined;
}

const WEEK_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

/** cron → 人话。认不出来的形态就原样回 `cron …`，不硬猜。 */
export function describeCron(spec: CronSpec): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  if (spec.minutes.length === 1 && spec.hours.length >= 1) {
    const clock = spec.hours.map((h) => `${pad(h)}:${pad(spec.minutes[0])}`).join("、");
    const domAll = spec.daysOfMonth.length === 31;
    if (domAll && !spec.dowRestricted) {
      return spec.months.length === 12 ? `每天 ${clock}` : `${spec.months.join("、")} 月的每天 ${clock}`;
    }
    if (domAll && spec.dowRestricted) {
      const days = spec.daysOfWeek;
      if (days.length === 5 && days.every((d, i) => d === [1, 2, 3, 4, 5][i])) return `工作日 ${clock}`;
      if (days.length === 1) return `每周${WEEK_LABELS[days[0]]} ${clock}`;
      return `每周${days.map((d) => WEEK_LABELS[d]).join("、")} ${clock}`;
    }
    if (spec.daysOfMonth.length === 1 && !spec.dowRestricted) return `每月 ${spec.daysOfMonth[0]} 日 ${clock}`;
  }
  if (spec.minutes.length > 1 && spec.hours.length === 24) {
    const step = spec.minutes.length > 1 ? spec.minutes[1] - spec.minutes[0] : 0;
    if (step > 0 && spec.minutes.every((m, i) => m === i * step)) return `每 ${step} 分钟`;
  }
  return `cron ${spec.source}`;
}

/** `30m` / `2h` / `1d` / `90s` / `30分钟`；纯数字按分钟算。非法返回 undefined。 */
export function parseIntervalMs(text: string): number | undefined {
  const raw = text.trim().toLowerCase();
  if (!raw) return undefined;
  const m = raw.match(/^(\d+)\s*(s|秒|m|分|分钟|h|小时|时|d|天|日)$/);
  if (!m) {
    if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10) * 60_000;
    return undefined;
  }
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = m[2];
  if (unit === "s" || unit === "秒") return n * 1000;
  if (unit === "m" || unit === "分" || unit === "分钟") return n * 60_000;
  if (unit === "d" || unit === "天" || unit === "日") return n * 86_400_000;
  return n * 3_600_000;
}

export function describeInterval(ms: number): string {
  if (ms % 86_400_000 === 0) return `每 ${ms / 86_400_000} 天`;
  if (ms % 3_600_000 === 0) return `每 ${ms / 3_600_000} 小时`;
  if (ms % 60_000 === 0) return `每 ${ms / 60_000} 分钟`;
  return `每 ${Math.round(ms / 1000)} 秒`;
}

/** 本机时区的 `YYYY-MM-DD HH:mm`，卡片与日志统一用它 */
export function formatLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `HH:mm` → 当天的 {hour, minute}；不合法返回 undefined */
function parseClock(text: string): { hour: number; minute: number } | undefined {
  const m = text.trim().replace("：", ":").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return undefined;
  const hour = Number.parseInt(m[1], 10);
  const minute = Number.parseInt(m[2], 10);
  if (hour > 23 || minute > 59) return undefined;
  return { hour, minute };
}

/** 一次性时刻：绝对时间（2026-11-22 09:00）、当天/次日（09:00）、相对（+30m） */
export function parseOnceAt(text: string, now = Date.now()): number | undefined {
  const raw = text.trim();
  if (!raw) return undefined;

  const relative = raw.match(/^\+\s*(\d+)\s*(s|秒|m|分|分钟|h|小时|时|d|天|日)$/i);
  if (relative) {
    const delta = parseIntervalMs(`${relative[1]}${relative[2]}`);
    return delta ? now + delta : undefined;
  }

  const absolute = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (absolute) {
    const [, y, mo, d, h, mi, s] = absolute;
    const year = Number.parseInt(y, 10);
    const month = Number.parseInt(mo, 10);
    const day = Number.parseInt(d, 10);
    const hour = Number.parseInt(h, 10);
    const minute = Number.parseInt(mi, 10);
    const second = s ? Number.parseInt(s, 10) : 0;
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined;
    const at = new Date(year, month - 1, day, hour, minute, second, 0);
    // 防「2026-02-31」被 Date 悄悄滚到 3 月
    if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== day) return undefined;
    return at.getTime();
  }

  const clock = parseClock(raw);
  if (clock) {
    const base = new Date(now);
    const at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), clock.hour, clock.minute, 0, 0);
    return at.getTime() > now ? at.getTime() : at.getTime() + 86_400_000;
  }
  return undefined;
}

const WEEK_INDEX: Record<string, number> = {
  日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
  "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "0": 0, "7": 0,
};

/** 「每天 09:00」「工作日 09:00」「每周一 09:00」「每小时」这类中文写法 → cron */
function cronFromTimes(times: string[]): { minutes: number[]; hours: number[] } | undefined {
  const clocks = times.map(parseClock);
  if (clocks.some((c) => !c)) return undefined;
  const valid = clocks as { hour: number; minute: number }[];
  return { minutes: valid.map((c) => c.minute), hours: valid.map((c) => c.hour) };
}

function cronResult(expr: string): ScheduleSpecResult {
  try {
    const spec = parseCron(expr);
    return { ok: true, kind: "cron", cron: spec.source, description: describeCron(spec) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function splitTimes(rest: string): string[] {
  return rest
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 把用户输入的时间表达式解析成任务类型。
 * 支持的写法（按判定顺序）：`cron 0 9 * * *`、裸 5 段 cron、每天/工作日/每周X、每小时、
 * 每 N 分钟/小时/天、间隔 …、一次性（绝对 / HH:mm / +30m）。
 */
export function parseScheduleSpec(text: string, now = Date.now()): ScheduleSpecResult {
  const input = text.trim();
  if (!input) return { ok: false, error: "时间表达式为空" };

  const cronPrefix = input.match(/^cron\s+(.+)$/is);
  if (cronPrefix) return cronResult(cronPrefix[1]);

  if (input.split(/\s+/).length === 5 && /^[\d*\-,/?\s]+$/.test(input)) return cronResult(input);

  const everyByStep = input.match(/^每\s*(\d+)\s*(分钟|分|小时|时|天|日|秒)$/);
  if (everyByStep) {
    const ms = parseIntervalMs(`${everyByStep[1]}${everyByStep[2]}`);
    return everyResult(ms, now);
  }
  const everyPrefix = input.match(/^(?:间隔|每隔|every)\s*(.+)$/is);
  if (everyPrefix) return everyResult(parseIntervalMs(everyPrefix[1]), now);

  if (/^每小时$/.test(input)) return cronResult("0 * * * *");

  const daily = input.match(/^(?:每天|每日)\s*(.+)$/);
  if (daily) {
    const times = cronFromTimes(splitTimes(daily[1]));
    if (!times) return { ok: false, error: `「每天」后面要跟时刻，例如「每天 09:00」：${daily[1]}` };
    const uniqueMinutes = Array.from(new Set(times.minutes));
    if (uniqueMinutes.length > 1) {
      return {
        ok: false,
        error: "一天多个不同分钟的时刻暂不支持，请写成 cron，例如「cron 0 9,18 * * *」",
      };
    }
    return cronResult(`${uniqueMinutes[0]} ${Array.from(new Set(times.hours)).sort((a, b) => a - b).join(",")} * * *`);
  }

  const workday = input.match(/^工作日\s*(.+)$/);
  if (workday) {
    const times = cronFromTimes(splitTimes(workday[1]));
    if (!times) return { ok: false, error: `「工作日」后面要跟时刻，例如「工作日 09:00」：${workday[1]}` };
    const minute = Array.from(new Set(times.minutes));
    if (minute.length > 1) return { ok: false, error: "工作日多时刻请用 cron，例如「cron 0 9,18 * * 1-5」" };
    return cronResult(`${minute[0]} ${Array.from(new Set(times.hours)).sort((a, b) => a - b).join(",")} * * 1-5`);
  }

  const monthly = input.match(/^每(?:个)?月\s*(\d{1,2})\s*[日号]\s*(.+)$/);
  if (monthly) {
    const dom = Number(monthly[1]);
    if (dom < 1 || dom > 31) return { ok: false, error: `「每月」的日期要在 1-31 之间：${monthly[1]}` };
    const times = cronFromTimes(splitTimes(monthly[2]));
    if (!times) return { ok: false, error: `「每月 N 日」后面要跟时刻，例如「每月 1 日 09:00」：${input}` };
    const minute = Array.from(new Set(times.minutes));
    if (minute.length > 1) return { ok: false, error: "每月多时刻请用 cron 表达式，例如「cron 0 9,18 1 * *」" };
    return cronResult(`${minute[0]} ${Array.from(new Set(times.hours)).sort((a, b) => a - b).join(",")} ${dom} * *`);
  }

  const weekly = input.match(/^每(?:周|星期)\s*([一二三四五六日天0-7])\s*(.+)$/);
  if (weekly) {
    const dow = WEEK_INDEX[weekly[1]];
    const times = cronFromTimes(splitTimes(weekly[2]));
    if (dow === undefined || !times) {
      return { ok: false, error: `「每周X」后面要跟时刻，例如「每周一 09:00」：${input}` };
    }
    const minute = Array.from(new Set(times.minutes));
    if (minute.length > 1) return { ok: false, error: "每周多时刻请用 cron 表达式" };
    return cronResult(`${minute[0]} ${Array.from(new Set(times.hours)).sort((a, b) => a - b).join(",")} * * ${dow}`);
  }

  const oncePrefix = input.match(/^(?:一次性|定时|at)\s*(.+)$/is);
  const at = parseOnceAt(oncePrefix ? oncePrefix[1] : input, now);
  if (at !== undefined) {
    if (at <= now) return { ok: false, error: `这个时刻已经过去了：${formatLocal(at)}` };
    return { ok: true, kind: "once", at, description: `${formatLocal(at)}（一次性）` };
  }

  return {
    ok: false,
    error:
      "认不出这个时间。可用写法：每天 09:00 / 工作日 09:00 / 每周一 09:00 / 每月 1 日 09:00 / 每小时 / 每 30 分钟 / 2026-11-22 09:00 / cron 0 9 * * *",
  };
}

function everyResult(ms: number | undefined, now: number): ScheduleSpecResult {
  if (!ms) return { ok: false, error: "间隔写法不对，例如「每 30 分钟」「间隔 2 小时」" };
  if (ms < MIN_EVERY_MS) return { ok: false, error: `间隔不能小于 1 分钟（收到 ${describeInterval(ms)}）` };
  const description = describeInterval(ms);
  if (!Number.isFinite(now)) return { ok: true, kind: "every", everyMs: ms, description };
  return { ok: true, kind: "every", everyMs: ms, description };
}

/**
 * 任务的下一次触发时刻。锚点 = 上次触发时间；从没跑过就用创建时间。
 * 这也是「只补最近一次」的实现基础：机器睡了 8 小时回来，只算出一个 due，不会补 8 次。
 */
export function computeNextRunAt(
  job: { kind: ScheduleKind; cron?: string; everyMs?: number; at?: number; createdAt: number; lastRunAt?: number },
  now = Date.now(),
): number | undefined {
  if (job.kind === "once") return job.at;
  const anchor = job.lastRunAt ?? job.createdAt;
  if (job.kind === "every") {
    if (!job.everyMs || job.everyMs <= 0) return undefined;
    if (job.lastRunAt === undefined) return anchor + job.everyMs;
    // 长期停摆后不要补一串：直接落到「现在之后」的第一个格点
    const missed = Math.floor((now - anchor) / job.everyMs);
    return anchor + job.everyMs * Math.max(1, missed);
  }
  if (!job.cron) return undefined;
  try {
    return nextCronTime(parseCron(job.cron), anchor);
  } catch {
    return undefined;
  }
}
