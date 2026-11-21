/**
 * 定时任务调度器：按时间表达式把任务「唤醒」成一次 pi 会话，结果用流式卡片回传到飞书。
 *
 * 三条设计约束（都是踩过的坑换来的）：
 * 1. **只补最近一次**：机器睡了 8 小时回来，只跑一次并标注「补跑」，不会补 8 条一样的消息；
 * 2. **同一任务不并发**：上一轮还在跑就跳过本次；不同任务之间也串行（同一进程里的模型会话别抢 CPU）；
 * 3. **每次全新会话**：任务之间不共享上下文，避免「昨天的日报」污染今天的。
 */
import { debugLog } from "./debug.ts";
import { ReplyCard } from "./reply-card.ts";
import { ScheduleStore, type ScheduleJob } from "./schedule-store.ts";
import { computeNextRunAt, formatLocal } from "./schedule-time.ts";
import type { FeishuBridgeStore } from "./bridge-store.ts";
import type { ConversationRuntime } from "./runtime.ts";
import type { FeishuTransport } from "./transport.ts";

/** 定时任务用的会话 key 前缀；与飞书真实会话（p2p:/group:）不会撞 */
export const SCHEDULE_SESSION_PREFIX = "sched:";

export function scheduleSessionKey(id: string): string {
  return `${SCHEDULE_SESSION_PREFIX}${id}`;
}

/** tick 间隔：20s 足够准（用户感知是「准点」），又不至于空转烧 CPU */
const DEFAULT_TICK_MS = 20_000;
/** 超过这个延迟才算「补跑」，正常 tick 抖动不该被标成补跑 */
const CATCHUP_THRESHOLD_MS = 90_000;
/** 启动后第一次扫描的延迟：等网关连接就绪再扫，别在没连上时白跑一遍 */
const BOOT_SCAN_DELAY_MS = 5_000;

export type SchedulerDeps = {
  store: ScheduleStore;
  conversations: ConversationRuntime;
  getTransport: () => FeishuTransport | undefined;
  getBridgeStore?: () => FeishuBridgeStore | undefined;
  tickMs?: number;
  now?: () => number;
};

export type FireOptions = {
  /** 计划触发时刻（写进提示词，也让「补跑」判断有依据） */
  at?: number;
  catchUp?: boolean;
  /** 用户手动点「立即执行」：允许跑已暂停的任务 */
  manual?: boolean;
};

export class FeishuScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private bootTimer: ReturnType<typeof setTimeout> | undefined;
  private ticking = false;
  /** 正在执行的任务编号（同一任务不并发） */
  private readonly running = new Set<string>();
  /** 任务之间串行：排队跑，避免多轮模型会话同时抢 CPU */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly deps: SchedulerDeps;
  private readonly now: () => number;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  start() {
    if (this.timer) return;
    const tickMs = Math.max(5_000, this.deps.tickMs ?? DEFAULT_TICK_MS);
    this.timer = setInterval(() => {
      void this.tick();
    }, tickMs);
    this.timer.unref?.();
    this.bootTimer = setTimeout(() => {
      void this.tick();
    }, BOOT_SCAN_DELAY_MS);
    this.bootTimer.unref?.();
    debugLog("feishu.schedule.started", { tickMs });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.timer = undefined;
    this.bootTimer = undefined;
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /** 任务被删除时，把它的临时会话路由一起清掉 */
  dropRoute(id: string) {
    this.deps.getBridgeStore?.()?.unbindRoute?.(scheduleSessionKey(id));
  }

  /**
   * 扫一遍到期的任务并排队执行。
   * 返回本轮判定为「该跑」的任务编号，便于测试与日志核对。
   */
  async tick(): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const due: string[] = [];
    try {
      const now = this.now();
      for (const job of this.deps.store.list()) {
        if (!job.enabled) continue;
        const next = computeNextRunAt(job, now);
        if (next === undefined || now < next) continue;
        if (this.running.has(job.id)) {
          debugLog("feishu.schedule.skip_busy", { id: job.id, next });
          continue;
        }
        due.push(job.id);
        const catchUp = now - next > CATCHUP_THRESHOLD_MS;
        this.enqueue(job.id, { at: next, catchUp });
      }
    } catch (error) {
      debugLog("feishu.schedule.tick_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.ticking = false;
    }
    return due;
  }

  /** 等待排队中的任务跑完（测试与停机前用） */
  async waitForIdle(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  private enqueue(id: string, options: FireOptions) {
    this.queue = this.queue
      .then(() => this.fireById(id, options))
      .catch((error) => {
        debugLog("feishu.schedule.queue_error", {
          id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /** 手动触发（按钮 / 命令）：不排队，直接返回是否成功发起 */
  async runNow(id: string): Promise<{ ok: boolean; error?: string }> {
    const job = this.deps.store.get(id);
    if (!job) return { ok: false, error: "任务不存在" };
    if (this.running.has(job.id)) return { ok: false, error: "这个任务正在执行中，等它跑完" };
    this.enqueue(job.id, { manual: true });
    return { ok: true };
  }

  /** 排队后的入口：重新从存储里取一次，防止排队期间任务被删/被暂停 */
  private async fireById(id: string, options: FireOptions) {
    const job = this.deps.store.get(id);
    if (!job) return false;
    if (!job.enabled && !options.manual) return false;
    return this.fire(job, options);
  }

  async fire(job: ScheduleJob, options: FireOptions = {}): Promise<boolean> {
    const transport = this.deps.getTransport();
    if (!transport?.isRunning?.()) {
      // 连接没起来就什么都不写：等连上了，这一次仍然算「到期」，会自动补跑
      debugLog("feishu.schedule.skip_no_transport", { id: job.id });
      return false;
    }
    if (this.running.has(job.id)) return false;
    this.running.add(job.id);
    const at = options.at ?? this.now();
    const key = scheduleSessionKey(job.id);
    let card: ReplyCard | undefined;
    try {
      this.deps.getBridgeStore?.()?.bindScheduledRoute(key, job.target);
      this.deps.store.markStarted(job.id, at);
      card = new ReplyCard(
        key,
        job.target.threadMessageId
          ? { replyToMessageId: job.target.threadMessageId, replyInThread: true }
          : { chatId: job.target.chatId },
        transport,
      );
      card.setTitle(`⏰ ${job.name}`);
      await card.start();
      // 每次全新会话：onReply 给空函数，静默重置，不往飞书发任何提示
      await this.deps.conversations.newConversation(key, async () => {});
      await this.deps.conversations.promptWithImages(
        key,
        buildScheduledPrompt(job, at, options),
        [],
        async (reply) => card?.completeWithAnswer(reply || "（本轮没有输出）"),
        card,
        (delta) => card?.append(delta),
      );
      const failed = card.finalStatus === "failed";
      this.deps.store.markFinished(job.id, failed
        ? { status: "failed", error: card.bodyText.slice(0, 200) || "执行失败" }
        : { status: "ok" });
      debugLog("feishu.schedule.done", {
        id: job.id,
        at,
        catchUp: Boolean(options.catchUp),
        manual: Boolean(options.manual),
        failed,
        chars: card.bodyText.length,
      });
      return !failed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.store.markFinished(job.id, { status: "failed", error: message });
      debugLog("feishu.schedule.error", { id: job.id, error: message });
      // 卡片都发不出去时，至少用纯文本把失败原因送到通知会话，否则用户永远不知道任务死了
      if (!card?.messageId) {
        await transport
          .sendText(job.target.chatId, `⏰ 定时任务「${job.name}」执行失败：${message}`)
          .catch(() => undefined);
      }
      return false;
    } finally {
      this.running.delete(job.id);
    }
  }
}

/** 定时任务的提示词：先把「这是什么、什么时候触发、什么会话」交代清楚，再放任务内容 */
export function buildScheduledPrompt(job: ScheduleJob, at: number, options: FireOptions = {}): string {
  const lines = [
    `[飞书定时任务] ${job.name}（编号 ${job.id}）`,
    `触发时间：${formatLocal(at)}`,
  ];
  if (options.catchUp) lines.push("说明：这是桥接恢复后补跑的最近一次触发，中间错过的时刻不补。");
  if (options.manual) lines.push("说明：这是用户手动点「立即执行」触发的。");
  lines.push("说明：结果会以流式卡片的形式发回飞书会话，不需要再问用户是否收到。");
  lines.push("", "任务内容：", job.prompt);
  return lines.join("\n");
}

