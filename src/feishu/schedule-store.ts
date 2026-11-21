/**
 * 飞书定时任务的持久化存储。
 *
 * 一个实例目录一份（`<实例目录>/schedules.pi.json`），跟着工作区走：
 * 同一台机器上不同工作区的机器人各管各的任务，互不可见。
 * 读写都走 config.ts 的 readJson/writeJson（后者会 chmod 0600）。
 */
import { dirname, join } from "node:path";
import { getRuntimeSource, readJson, writeJson } from "./config.ts";
import type { ScheduleKind } from "./schedule-time.ts";

export type ScheduleChatType = "p2p" | "group";

/** 通知落点：创建任务的那个会话；`/sched notify` 可以改到别处 */
export type ScheduleTarget = {
  chatId: string;
  chatType: ScheduleChatType;
  /** 话题群 / 回复链：回到这条消息所在的话题；普通会话留空 */
  threadMessageId?: string;
  /** 展示用的会话名，例如「群：研发值班」 */
  label?: string;
  /** 最后一次改通知落点的时间 */
  updatedAt?: number;
};

export type ScheduleStatus = "ok" | "failed";

export type ScheduleJob = {
  /** 短编号，用户输入用（6 位小写字母数字） */
  id: string;
  name: string;
  /** 交给 pi 的任务内容 */
  prompt: string;
  kind: ScheduleKind;
  /** kind=cron */
  cron?: string;
  /** kind=every */
  everyMs?: number;
  /** kind=once，毫秒时间戳 */
  at?: number;
  /** 人类可读的时间描述（创建时冻结，卡片展示用） */
  timeLabel: string;
  enabled: boolean;
  target: ScheduleTarget;
  /** 创建者 open_id（仅审计，权限口径是「谁看到谁可管」） */
  createdBy?: string;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastStatus?: ScheduleStatus;
  lastError?: string;
  runCount: number;
};

export type FeishuScheduleState = {
  version: 1;
  jobs: Record<string, ScheduleJob>;
};

export type CreateJobInput = {
  name: string;
  prompt: string;
  kind: ScheduleKind;
  cron?: string;
  everyMs?: number;
  at?: number;
  timeLabel: string;
  target: ScheduleTarget;
  createdBy?: string;
};

/** 单实例任务上限：再多就不是「定时任务」而是失控的刷屏源 */
export const MAX_JOBS = 50;
const ID_LENGTH = 6;

function schedulePath(): string {
  return join(dirname(getRuntimeSource().configPath), "schedules.pi.json");
}

function emptyState(): FeishuScheduleState {
  return { version: 1, jobs: {} };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 逐字段校验：文件可能被手改过，坏条目丢弃而不是让整个调度器崩掉 */
function normalizeJob(raw: unknown): ScheduleJob | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const job = raw as Partial<ScheduleJob>;
  if (!job.id || typeof job.id !== "string") return undefined;
  if (!job.prompt || typeof job.prompt !== "string") return undefined;
  if (job.kind !== "cron" && job.kind !== "every" && job.kind !== "once") return undefined;
  if (!job.target || typeof job.target.chatId !== "string") return undefined;
  const kind = job.kind;
  if (kind === "cron" && typeof job.cron !== "string") return undefined;
  if (kind === "every" && !isFiniteNumber(job.everyMs)) return undefined;
  if (kind === "once" && !isFiniteNumber(job.at)) return undefined;
  const createdAt = isFiniteNumber(job.createdAt) ? job.createdAt : Date.now();
  return {
    id: job.id,
    name: typeof job.name === "string" && job.name.trim() ? job.name.trim() : job.id,
    prompt: job.prompt,
    kind,
    cron: job.cron,
    everyMs: job.everyMs,
    at: job.at,
    timeLabel: typeof job.timeLabel === "string" ? job.timeLabel : "（未记录）",
    enabled: job.enabled !== false,
    target: {
      chatId: job.target.chatId,
      chatType: job.target.chatType === "group" ? "group" : "p2p",
      threadMessageId: typeof job.target.threadMessageId === "string" ? job.target.threadMessageId : undefined,
      label: typeof job.target.label === "string" ? job.target.label : undefined,
      updatedAt: isFiniteNumber(job.target.updatedAt) ? job.target.updatedAt : undefined,
    },
    createdBy: typeof job.createdBy === "string" ? job.createdBy : undefined,
    createdAt,
    updatedAt: isFiniteNumber(job.updatedAt) ? job.updatedAt : createdAt,
    lastRunAt: isFiniteNumber(job.lastRunAt) ? job.lastRunAt : undefined,
    lastStatus: job.lastStatus === "ok" || job.lastStatus === "failed" ? job.lastStatus : undefined,
    lastError: typeof job.lastError === "string" ? job.lastError : undefined,
    runCount: isFiniteNumber(job.runCount) && job.runCount >= 0 ? job.runCount : 0,
  };
}

export class ScheduleStore {
  private state: FeishuScheduleState;
  private readonly path: string;

  constructor(path = schedulePath()) {
    this.path = path;
    this.state = this.load();
  }

  private load(): FeishuScheduleState {    const raw = readJson<unknown>(this.path, emptyState());
    if (!raw || typeof raw !== "object") return emptyState();
    const jobsRaw = (raw as { jobs?: unknown }).jobs;
    if (!jobsRaw || typeof jobsRaw !== "object") return emptyState();
    const jobs: Record<string, ScheduleJob> = {};
    for (const [id, value] of Object.entries(jobsRaw as Record<string, unknown>)) {
      const job = normalizeJob({ ...(value as object), id: (value as ScheduleJob)?.id ?? id });
      if (job) jobs[job.id] = job;
    }
    return { version: 1, jobs };
  }

  private save() {
    writeJson(this.path, this.state);
  }

  /** 任务列表（按创建时间升序，卡片保持稳定顺序） */
  list(): ScheduleJob[] {
    return Object.values(this.state.jobs).sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): ScheduleJob | undefined {
    return this.state.jobs[normalizeId(id)];
  }

  /** 编号可能带 `/sched` 的 `#`、大小写混写；统一成小写再查 */
  private newId(): string | undefined {
    for (let i = 0; i < 200; i += 1) {
      const id = Math.random().toString(36).slice(2, 2 + ID_LENGTH).padEnd(ID_LENGTH, "0");
      if (!this.state.jobs[id]) return id;
    }
    return undefined;
  }

  create(input: CreateJobInput): ScheduleJob {
    if (Object.keys(this.state.jobs).length >= MAX_JOBS) {
      throw new Error(`任务数已达上限 ${MAX_JOBS}，先删掉不用的再建`);
    }
    const id = this.newId();
    if (!id) throw new Error("生成任务编号失败，请重试");
    const now = Date.now();
    const job: ScheduleJob = {
      id,
      name: input.name,
      prompt: input.prompt,
      kind: input.kind,
      cron: input.cron,
      everyMs: input.everyMs,
      at: input.at,
      timeLabel: input.timeLabel,
      enabled: true,
      target: { ...input.target, updatedAt: now },
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      runCount: 0,
    };
    this.state.jobs[id] = job;
    this.save();
    return job;
  }

  update(id: string, patch: Partial<ScheduleJob>): ScheduleJob | undefined {
    const job = this.get(id);
    if (!job) return undefined;
    const next: ScheduleJob = { ...job, ...patch, id: job.id, updatedAt: Date.now() };
    this.state.jobs[job.id] = next;
    this.save();
    return next;
  }

  /** 改通知落点：顺带把「上次跑到哪」清掉，避免旧会话的时间锚点影响新落点 */
  retarget(id: string, target: ScheduleTarget): ScheduleJob | undefined {
    return this.update(id, { target: { ...target, updatedAt: Date.now() } });
  }

  /** 记录开始执行：立刻写下 lastRunAt，进程中途挂了也不会反复重跑同一格 */
  markStarted(id: string, at = Date.now()): ScheduleJob | undefined {
    const job = this.get(id);
    if (!job) return undefined;
    const next: ScheduleJob = {
      ...job,
      lastRunAt: at,
      runCount: job.runCount + 1,
      updatedAt: Date.now(),
    };
    this.state.jobs[job.id] = next;
    this.save();
    return next;
  }

  /** 记录执行结果；一次性任务跑完自动关掉，留档供查看 */
  markFinished(id: string, result: { status: ScheduleStatus; error?: string }): ScheduleJob | undefined {
    const job = this.get(id);
    if (!job) return undefined;
    const next: ScheduleJob = {
      ...job,
      lastStatus: result.status,
      lastError: result.status === "failed" ? result.error : undefined,
      updatedAt: Date.now(),
      enabled: job.kind === "once" ? false : job.enabled,
    };
    this.state.jobs[job.id] = next;
    this.save();
    return next;
  }

  remove(id: string): boolean {
    const key = normalizeId(id);
    if (!this.state.jobs[key]) return false;
    delete this.state.jobs[key];
    this.save();
    return true;
  }

  /** 重新加载磁盘内容（手工编辑 schedules.pi.json 后不必重启 daemon） */
  reload(): ScheduleJob[] {
    this.state = this.load();
    return this.list();
  }

  get pathUsed(): string {
    return this.path;
  }
}

export function normalizeId(raw: string): string {
  return raw.trim().replace(/^#/, "").toLowerCase();
}
