/**
 * 定时任务的业务编排层：把「命令 / 按钮 / 表单」三种入口统一到同一套 CRUD。
 *
 * 分工：
 * - schedule-time.ts   表达式解析与下次触发时间（纯函数，可单测）
 * - schedule-store.ts  落盘
 * - schedule-cards.ts  卡片长相
 * - scheduler.ts       到点执行
 * - 本文件             校验输入、解析「在本会话创建」的目标、给用户回卡片
 */
import { debugLog } from "./debug.ts";
import {
  buildScheduleCard,
  buildScheduleFormCard,
  parseScheduleActionValue,
  SCHEDULE_FORM,
} from "./schedule-cards.ts";
import { ScheduleStore, MAX_JOBS, type ScheduleJob, type ScheduleTarget } from "./schedule-store.ts";
import { computeNextRunAt, formatLocal, parseScheduleSpec, type ScheduleKind } from "./schedule-time.ts";
import type { FeishuScheduler } from "./scheduler.ts";
import type { FeishuCardAction, FeishuMessage } from "./types.ts";
import type { FeishuTransport } from "./transport.ts";

export type ScheduleServiceDeps = {
  store: ScheduleStore;
  scheduler: FeishuScheduler;
  getTransport: () => FeishuTransport | undefined;
  now?: () => number;
};

/** 删除要求二次确认，确认态保留 60 秒后自动失效（避免误点一条陈旧的确认按钮） */
const PENDING_DELETE_TTL_MS = 60_000;

export class FeishuScheduleService {
  private readonly pendingDelete = new Map<string, number>();
  private readonly deps: ScheduleServiceDeps;
  private readonly now: () => number;

  constructor(deps: ScheduleServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** 处理 `/sched` 及其子命令；返回 true 表示已消费这条消息 */
  async handleCommand(msg: FeishuMessage, rawArgs: string): Promise<boolean> {
    const transport = this.deps.getTransport();
    if (!transport) return true;
    const args = (rawArgs || "").trim();
    const sub = args.split(/\s+/)[0]?.toLowerCase() || "";

    if (!args || ["list", "ls", "列表", "?list"].includes(sub)) {
      await transport.replyCard(msg.messageId, this.renderCard(await this.labelFor(msg.chatId, msg.chatType)));
      return true;
    }

    if (["add", "new", "create", "新建", "创建"].includes(sub)) {
      await transport.replyCard(
        msg.messageId,
        buildScheduleFormCard({ originLabel: await this.labelFor(msg.chatId, msg.chatType) }),
      );
      return true;
    }

    if (["help", "-h", "--help", "帮助"].includes(sub)) {
      await transport.replyText(msg.messageId, HELP_TEXT);
      return true;
    }

    // 其余情况当作「一句话建任务」：/sched 每天 9:00 | 生成昨日日报
    const split = this.splitSpecAndPrompt(args);
    if ("error" in split) {
      await transport.replyText(msg.messageId, split.error);
      return true;
    }
    const created = await this.create({
      specText: split.spec,
      prompt: split.prompt,
      target: this.targetFromMessage(msg).target,
      createdBy: msg.senderOpenId,
    });
    if ("error" in created) {
      await transport.replyText(msg.messageId, created.error);
      return true;
    }
    await transport.replyCard(
      msg.messageId,
      this.renderCard(await this.labelFor(msg.chatId, msg.chatType),
        `✅ 已创建「${created.job.name}」，${created.job.timeLabel}；通知发到本会话。`),
    );
    return true;
  }

  /** 处理卡片按钮回调；返回新卡片用于原地刷新 */
  async handleAction(action: FeishuCardAction): Promise<object | void> {
    const value = parseScheduleActionValue(action.value);
    if (!value) return;
    const transport = this.deps.getTransport();
    const chatId = action.chatId;
    const origin = chatId
      ? await this.resolveTarget(chatId, undefined, value.action === "pi_feishu_sched_notify" ? action.messageId : undefined)
      : undefined;
    const originLabel = chatId ? await this.labelFor(chatId, undefined) : "";

    if (value.action === "pi_feishu_sched_add") {
      return buildScheduleFormCard({ originLabel });
    }
    if (value.action === "pi_feishu_sched_refresh") {
      return this.renderCard(originLabel);
    }

    if (value.action === "pi_feishu_sched_create") {
      return this.createFromForm(action, origin, originLabel);
    }

    const job = this.deps.store.get(value.id);
    if (!job) return this.renderCard(originLabel, "❌ 该任务已不存在（可能已被删除）。");

    if (value.action === "pi_feishu_sched_toggle") {
      const next = this.deps.store.update(job.id, { enabled: !job.enabled });
      return this.renderCard(originLabel, next?.enabled ? `▶️ 已恢复「${job.name}」` : `⏸ 已暂停「${job.name}」`);
    }

    if (value.action === "pi_feishu_sched_run") {
      const result = await this.deps.scheduler.runNow(job.id);
      if (!result.ok) return this.renderCard(originLabel, `❌ 无法执行：${result.error || "未知原因"}`);
      if (transport && chatId) {
        await transport
          .sendText(chatId, `⏰ 已手动触发「${job.name}」，结果会以卡片发到通知会话里。`)
          .catch(() => undefined);
      }
      return this.renderCard(originLabel, `🚀 已触发「${job.name}」`);
    }

    if (value.action === "pi_feishu_sched_notify") {
      if (!origin) return this.renderCard(originLabel, "❌ 无法识别当前会话，改通知失败。");
      this.deps.store.retarget(job.id, origin);
      return this.renderCard(originLabel, `📮 「${job.name}」的通知已改到本会话。`);
    }

    if (value.action === "pi_feishu_sched_delete") {
      if (value.confirm) {
        this.pendingDelete.delete(job.id);
        this.deps.store.remove(job.id);
        this.deps.scheduler.dropRoute(job.id);
        return this.renderCard(originLabel, `🗑 已删除「${job.name}」`);
      }
      this.pendingDelete.set(job.id, this.now() + PENDING_DELETE_TTL_MS);
      return this.renderCard(originLabel, `确认删除「${job.name}」？60 秒内再点一次「确认删除」。`);
    }

    return;
  }

  /** 新建任务：表单与一句话共用同一套校验 */
  private async create(input: {
    specText: string;
    prompt: string;
    name?: string;
    target: ScheduleTarget;
    createdBy?: string;
  }): Promise<{ ok: true; job: ScheduleJob } | { ok: false; error: string }> {
    if (this.deps.store.list().length >= MAX_JOBS) {
      return { ok: false, error: `❌ 定时任务最多 ${MAX_JOBS} 个，请先删除不用的任务。` };
    }
    const prompt = input.prompt.trim();
    if (!prompt) return { ok: false, error: "❌ 任务内容不能为空：请说明这一轮要让 pi 做什么。" };
    const spec = parseScheduleSpec(input.specText, this.now());
    if ("error" in spec) return { ok: false, error: `❌ 时间格式无法识别：${spec.error}` };
    const fields: { kind: ScheduleKind; cron?: string; everyMs?: number; at?: number } = { kind: spec.kind };
    if ("cron" in spec) fields.cron = spec.cron;
    if ("everyMs" in spec) fields.everyMs = spec.everyMs;
    if ("at" in spec) fields.at = spec.at;
    try {
      const job = this.deps.store.create({
        name: (input.name || "").trim() || deriveName(prompt),
        prompt,
        kind: fields.kind,
        cron: fields.cron,
        everyMs: fields.everyMs,
        at: fields.at,
        timeLabel: spec.description,
        target: input.target,
        createdBy: input.createdBy,
      });
      debugLog("feishu.schedule.created", { id: job.id, kind: job.kind, timeLabel: job.timeLabel });
      return { ok: true, job };
    } catch (error) {
      return { ok: false, error: `❌ ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private async createFromForm(
    action: FeishuCardAction,
    origin: ScheduleTarget | undefined,
    originLabel: string,
  ): Promise<object> {
    const values = (action.formValue || {}) as Record<string, unknown>;
    const pick = (key: string) => (typeof values[key] === "string" ? String(values[key]).trim() : "");
    if (!origin) return this.renderCard(originLabel, "❌ 无法识别当前会话，创建失败。");
    const created = await this.create({
      specText: pick(SCHEDULE_FORM.timeField),
      prompt: pick(SCHEDULE_FORM.promptField),
      name: pick(SCHEDULE_FORM.nameField),
      target: origin,
      createdBy: action.operatorOpenId,
    });
    if ("error" in created) return this.renderCard(originLabel, created.error);
    return this.renderCard(originLabel, `✅ 已创建「${created.job.name}」，${created.job.timeLabel}；通知发到本会话。`);
  }

  /** 一句话建任务：支持 `时间 | 内容`，也支持 `时间 内容`（取能解析成功的最长前缀） */
  private splitSpecAndPrompt(raw: string): { spec: string; prompt: string } | { error: string } {
    const text = raw.trim();
    const pipe = text.indexOf("|");
    if (pipe > 0) {
      const spec = text.slice(0, pipe).trim();
      const prompt = text.slice(pipe + 1).trim();
      if (!prompt) return { error: "❌ 「|」后面要写任务内容。" };
      return { spec, prompt };
    }
    const tokens = text.split(/\s+/);
    for (let n = Math.min(6, tokens.length - 1); n >= 1; n -= 1) {
      const spec = tokens.slice(0, n).join(" ");
      if (parseScheduleSpec(spec, this.now()).ok) {
        return { spec, prompt: tokens.slice(n).join(" ") };
      }
    }
    return {
      error: [
        "❌ 没认出时间表达式。可以这样写：",
        "· /sched 每天 9:00 | 生成昨日订单日报",
        "· /sched 每 2 小时 | 检查测服健康状态",
        "· /sched cron 0 9 * * 1-5 | 汇总本周工单",
        "· /sched 2026-12-01 10:00 | 提醒我发版",
        "",
        "也可以直接发 /sched 打开管理面板，用「新建任务」表单填写。",
      ].join("\n"),
    };
  }

  private renderCard(originLabel: string, note?: string) {
    const now = this.now();
    for (const [id, expiresAt] of this.pendingDelete) {
      if (expiresAt <= now) this.pendingDelete.delete(id);
    }
    const pending = [...this.pendingDelete.entries()].filter(([, at]) => at > now).pop()?.[0];
    return buildScheduleCard(this.deps.store.list(), {
      originLabel,
      note,
      pendingDeleteId: pending && this.deps.store.get(pending) ? pending : undefined,
      now,
    });
  }

  /** 从触发命令的消息推出「通知到哪」：私聊就是本人，话题群要记住话题 */
  private targetFromMessage(msg: FeishuMessage): { target: ScheduleTarget } {
    const threadMessageId = msg.chatMode === "topic"
      ? msg.threadId || msg.rootId || msg.messageId
      : undefined;
    return {
      target: {
        chatId: msg.chatId,
        chatType: msg.chatType,
        threadMessageId,
        updatedAt: this.now(),
      },
    };
  }

  /**
   * 解析一次点按钮时的会话。按钮回调里没有 chatType，只能问飞书；
   * 拿不到就按群聊处理（私聊发群 ID 也能发出去，不会丢消息）。
   */
  private async resolveTarget(
    chatId: string,
    chatType: "p2p" | "group" | undefined,
    messageId?: string,
  ): Promise<ScheduleTarget> {
    const info = await this.chatInfo(chatId);
    const resolvedType = chatType ?? info.chatType ?? "group";
    return {
      chatId,
      chatType: resolvedType,
      threadMessageId: info.chatMode === "topic" ? messageId : undefined,
      updatedAt: this.now(),
    };
  }

  private async labelFor(chatId: string, chatType?: "p2p" | "group"): Promise<string> {
    if (chatType === "p2p") return "私聊";
    const info = await this.chatInfo(chatId);
    if (info.chatType === "p2p" || info.chatMode === "p2p") return "私聊";
    return info.name ? `群：${info.name}` : `群会话 ${chatId.slice(-6)}`;
  }

  /** 问飞书要会话名与模式；接口失败一律降级，不让卡片渲染因为一个请求挂掉 */
  private async chatInfo(chatId: string): Promise<{
    name?: string;
    chatType?: "p2p" | "group";
    chatMode?: "p2p" | "group" | "topic";
  }> {
    const transport = this.deps.getTransport();
    if (!transport?.isRunning?.()) return {};
    try {
      const res = await transport.requestApi<{ code?: number; data?: { name?: string; chat_mode?: string } }>({
        url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
        method: "GET",
      });
      if (res?.code && res.code !== 0) return {};
      const mode = res?.data?.chat_mode;
      const chatMode = mode === "p2p" || mode === "topic" ? mode : "group";
      return {
        name: res?.data?.name?.trim() || undefined,
        chatMode,
        chatType: chatMode === "p2p" ? "p2p" : "group",
      };
    } catch (error) {
      debugLog("feishu.schedule.chat_info_failed", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }
}

/** 任务名：取内容第一行，去掉 markdown 记号，最长 20 字 */
export function deriveName(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "定时任务";
  const plain = firstLine.replace(/[#>*`_~]/g, "").trim();
  return plain.length > 20 ? `${plain.slice(0, 20)}…` : plain || "定时任务";
}

/** 管理卡片顶部的一行统计，回答「现在到底会不会自动跑」 */
export function summarizeSchedules(jobs: ScheduleJob[], now = Date.now()): string {
  if (!jobs.length) return "还没有定时任务。";
  const enabled = jobs.filter((job) => job.enabled);
  const next = enabled
    .map((job) => ({ job, at: computeNextRunAt(job, now) }))
    .filter((item): item is { job: ScheduleJob; at: number } => item.at !== undefined)
    .sort((a, b) => a.at - b.at)[0];
  return next
    ? `共 ${jobs.length} 个（${enabled.length} 个启用），最近一次：${describeNextRun(next.at, now)}`
    : `共 ${jobs.length} 个，全部暂停。`;
}

/** 「2026-11-22 09:00（3 小时后）」这种给人看的时间描述 */
export function describeNextRun(at: number, now = Date.now()): string {
  const diff = at - now;
  const minutes = Math.round(diff / 60_000);
  const relative = minutes <= 0
    ? "即将触发"
    : minutes < 60
      ? `${minutes} 分钟后`
      : minutes < 1440
        ? `${Math.round(minutes / 60)} 小时后`
        : `${Math.round(minutes / 1440)} 天后`;
  return `${formatLocal(at)}（${relative}）`;
}

const HELP_TEXT = [
  "⏰ 定时任务用法",
  "",
  "· /sched                    打开管理面板",
  "· /sched 新建               表单新建",
  "· /sched <时间> | <任务>    一句话新建，如：/sched 每天 9:00 | 生成昨日日报",
  "",
  "支持的时间写法：每天 9:00、每天 9:00 18:00、工作日 9:00、每周一 10:00、",
  "每月 1 日 9:00、每 30 分钟、每 2 小时、cron 0 9 * * 1-5、2026-12-01 10:00",
  "",
  "任务默认通知到发起它的会话；在面板点「改通知到这里」可随时换会话。",
].join("\n");
