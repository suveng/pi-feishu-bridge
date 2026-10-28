/**
 * 回复呈现：
 * - 默认 CardKit streaming_mode：客户端逐字打印（print_step=1）
 * - 关闭流式时：先「回复中」卡，结束一次写入全文
 * - 不展示工具/阶段过程
 */
import { randomUUID } from "node:crypto";
import {
  buildReplyCard,
  defaultFinalNote,
  type ReplyCardFinalStatus,
  type ReplyCardStatus,
} from "./card-builder.ts";
import { CardKitStream, type CardKitTarget } from "./cardkit-stream.ts";
import { ProgressTracker, progressNeedsElement } from "./progress-note.ts";
import { resolveStreamOptions, type ReplyCardStreamOptions } from "./reply-card-options.ts";
import { loadConfig } from "./config.ts";
import { debugLog } from "./debug.ts";
import { registerLiveCard, unregisterLiveCard } from "./live-cards.ts";
import { flushLocalImages, stripLocalImageMarkdown } from "./image-send.ts";

export type { ReplyCardStatus, ReplyCardFinalStatus } from "./card-builder.ts";
export {
  buildReplyCard,
  parseStopTaskActionValue,
  STOP_ACTION,
} from "./card-builder.ts";

/**
 * 这张卡发到哪里。
 * chatId 优先（平铺一条新消息）；话题群/回复链必须用 replyToMessageId。
 */
export type ReplyCardTarget = CardKitTarget | { chatId: string; replyToMessageId?: string };

/** 路由快照：只取 resolveCardTarget 需要的字段，便于单测 */
export type CardRouteLike = {
  chatId: string;
  chatType: "p2p" | "group";
  threadMessageId?: string;
  lastMessageId: string;
};

/**
 * 决定卡片发到哪里（**唯一入口**，所有发卡路径都必须走它）。
 *
 * 回归背景：回答卡与选择题卡都 reply 同一条用户消息时，飞书把它们归成同一个
 * 回复簇，主聊天流只留最后一条预览 —— 先到的卡看起来被后到的「刷掉」了。
 * 因此普通会话改成平铺发新消息；只有话题群/回复链必须留在 reply 里，
 * 否则 create 会另开一个话题。
 */
export function resolveCardTarget(route: CardRouteLike): ReplyCardTarget {
  if (route.threadMessageId) return { replyToMessageId: route.lastMessageId };
  return { chatId: route.chatId };
}

export type ReplyCardSink = {
  readonly runId: string;
  readonly bodyText: string;
  /** 当前工具执行过程清单（停止回调要把同样的内容放回响应卡，否则清单会被刷没） */
  readonly progressText: string;
  /** 是否停在「等用户选择」的暂停态（askUser 出临界区前必须为 false） */
  readonly paused: boolean;
  updateFromEvent(event: unknown): void;
  stopImmediately(note?: string): Promise<void>;
  finish(status: ReplyCardFinalStatus, note?: string): Promise<void>;
  append(delta: string): void;
  ensureFinal(text: string): void;
  /** 进入选择题等待：定格当前段，不再往这张卡写正文 */
  pauseForAsk(note?: string): Promise<void>;
  /** 问答结束：把暂停卡翻成「已选择」，再开一段新的回复卡 */
  resume(): Promise<void>;
};

/** 转发给外部：卡片流式与过程展示的参数都在 reply-card-options.ts 里解析 */
export type { ReplyCardStreamOptions } from "./reply-card-options.ts";

type ReplyCardTransport = {
  replyCard(messageId: string, card: object): Promise<string | undefined>;
  updateCard(messageId: string, card: object): Promise<void>;
  /** 平铺发送一张卡片（非话题群默认路径） */
  createCard?(chatId: string, card: object): Promise<string | undefined>;
  replyPlainText?(messageId: string, text: string): Promise<string | undefined>;
  updateText?(messageId: string, text: string): Promise<void>;
  /** 记录本 bot 出站消息，供 groupAlsoOnReply */
  rememberOutboundMessageId?(messageId: string): void;
  /** 把本地图片发到回复链上（正文写了 `![](/绝对路径.png)` 时调用） */
  replyLocalImage?(messageId: string, filePath: string): Promise<string | undefined>;
  /** 平铺发本地图片（话题群/无回复锚点时用） */
  sendLocalImage?(chatId: string, filePath: string): Promise<string | undefined>;
};

export class ReplyCard implements ReplyCardSink {
  readonly runId = randomUUID();
  private status: ReplyCardStatus = "running";
  private body = "";
  private note: string | undefined;
  /** 续段的标题覆盖（「回复（接上条）」） */
  private title: string | undefined;
  /**
   * 分段记账（feishu_ask 等待会把一轮切成多段，每段一张卡）：
   * segmentStart 是本段在整轮文本里的起点，segmentDeltaChars 是本段已累计的 delta 字符数。
   * 轮末拿到整轮全量文本时靠这两个值切出本段正文，否则新段会把上一段重印一遍。
   */
  private segmentStart = 0;
  private segmentDeltaChars = 0;
  private readonly segments: { messageId?: string; text: string }[] = [];
  /** 当前段的卡片消息 ID（超时/收尾刷新用） */
  private segmentMessageId: string | undefined;
  get bodyText() { return this.body; }
  /** 停在「等用户选择」的中间态；askUser 出临界区前必须消掉 */
  get paused() { return this.status === "paused"; }
  private cardkit: CardKitStream | undefined;
  /** 工具执行过程清单；off 档也建一个但不能渲染，省得到处判空 */
  private readonly tracker: ProgressTracker;
  /** 收尾后冻结：轮末还会来事件，不能再改清单，否则定格的执行记录会变 */
  private trackerFrozen = false;
  private readonly streamOpts: ReturnType<typeof resolveStreamOptions>;
  private readonly key: string;
  private readonly target: ReplyCardTarget;
  private readonly transport: ReplyCardTransport;

  constructor(
    key: string,
    target: string | ReplyCardTarget,
    transport: ReplyCardTransport,
    streamOptions?: ReplyCardStreamOptions,
  ) {
    this.key = key;
    // 兼容旧的「传消息 ID」写法：等价于 reply 到那条消息
    this.target = typeof target === "string" ? { replyToMessageId: target } : target;
    this.transport = transport;
    this.streamOpts = resolveStreamOptions(streamOptions);
    this.tracker = new ProgressTracker({
      mode: this.streamOpts.progressMode,
      maxLines: this.streamOpts.progressMaxLines,
      timeoutSeconds: this.streamOpts.progressTimeoutSeconds,
    });
  }

  /** 当前过程清单文本（停止回调里要把同样的内容放回响应卡，否则清单会闪没） */
  get progressText(): string {
    return this.tracker.render() ?? "";
  }

  get messageId() {
    return this.segmentMessageId;
  }

  async start() {
    const cfg = loadConfig();
    if (this.streamOpts.enabled && cfg?.appId && cfg?.appSecret) {
      this.cardkit = new CardKitStream(
        cfg.appId,
        cfg.appSecret,
        cfg.domain === "lark" ? "lark" : "feishu",
        this.target,
        async (text) => {
          // CardKit 失败：回落为普通最终卡片
          const id = await this.sendCard(
            buildReplyCard({
              key: this.key,
              runId: this.runId,
              status: "done",
              body: text,
              title: this.title,
            }),
          );
          this.segmentMessageId = id;
        },
        {
          printFrequencyMs: this.streamOpts.printFrequencyMs,
          printStep: this.streamOpts.printStep,
          pushIntervalMs: this.streamOpts.pushIntervalMs,
          conversationKey: this.key,
          runId: this.runId,
          title: this.title,
          note: this.note,
          progressEnabled: progressNeedsElement(this.streamOpts.progressMode),
          // steps 档清单可能几十行，收进折叠面板；action / timeout 档只有一行，展开更直接
          progressCollapsed: this.streamOpts.progressMode === "steps",
          onOutboundMessageId: (id) => {
            this.segmentMessageId = id;
            this.transport.rememberOutboundMessageId?.(id);
          },
        },
      );
      // 清单由 tick 驱动刷新：Pi 在单个工具运行期间不发任何事件，
      // 只有让 CardKitStream 每次 tick 主动取数，timeout 档的「已执行 Ns」才会长。
      // title 是折叠面板收起后唯一能看到的一行，必须跟 body 一起取。
      this.cardkit.setProgressSource(() => ({
        title: this.tracker.renderTitle(),
        body: this.tracker.render() ?? "",
      }));
      debugLog("feishu.reply_card.cardkit_ready", {
        key: this.key,
        runId: this.runId,
        ...this.streamOpts,
      });
      // 先让飞书看到「回复中」，不等待 Pi 产出第一段正文；失败仍会在结束时回落为普通回复卡。
      void this.cardkit.startImmediately();
      // 登记在册：进程被 kill（重启）时由退出收尾统一翻成「已停止」，
      // 否则这张卡会永久停在「正在回复…」
      registerLiveCard(this);
      return;
    }

    // 非流式：先出「回复中」占位卡
    this.segmentMessageId = await this.sendCard(
      buildReplyCard({
        key: this.key,
        runId: this.runId,
        status: "running",
        note: this.note,
        title: this.title,
        body: "",
      }),
    );
    debugLog("feishu.reply_card.started_static", {
      key: this.key,
      runId: this.runId,
      cardMessageId: this.segmentMessageId,
    });
    registerLiveCard(this);
  }

  /** 按 target 决定平铺（create）还是回复（reply） */
  private async sendCard(card: object): Promise<string | undefined> {
    const target = this.target;
    if ("chatId" in target && target.chatId && this.transport.createCard) {
      return this.transport.createCard(target.chatId, card);
    }
    if ("replyToMessageId" in target && target.replyToMessageId) {
      return this.transport.replyCard(target.replyToMessageId, card);
    }
    if ("chatId" in target && target.chatId) {
      // 传输层不支持平铺（旧实现）：退回复路径，宁可多一条回复也不能把卡丢了
      const fallbackId = (target as { replyToMessageId?: string }).replyToMessageId;
      if (fallbackId) return this.transport.replyCard(fallbackId, card);
    }
    throw new Error("卡片发送目标缺失：既没有 chatId 也没有 replyToMessageId");
  }

  /**
   * 处理 Pi 会话事件，维护工具执行清单（本改造的核心）。
   *
   * 只更新内存里的清单状态，不发网络请求：
   * 卡片推送交给 CardKitStream 的 tick 定时器节流，避免工具密集切换时打爆卡片接口。
   */
  updateFromEvent(event: unknown) {
    if (this.trackerFrozen || this.tracker.mode === "off") return;
    if (!event || typeof event !== "object") return;
    const e = event as {
      type?: string;
      toolCallId?: string;
      toolName?: string;
      args?: unknown;
      isError?: boolean;
    };
    if (e.type === "tool_execution_start") {
      this.tracker.start(String(e.toolCallId ?? ""), String(e.toolName ?? "tool"), e.args);
      debugLog("feishu.progress.tool_start", {
        key: this.key,
        runId: this.runId,
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        steps: this.tracker.size,
      });
      return;
    }
    if (e.type === "tool_execution_end") {
      this.tracker.end(String(e.toolCallId ?? ""), e.isError !== true);
      return;
    }
    // 其余事件（text_delta / message_end 等）与过程清单无关
  }

  append(delta: string) {
    if (this.status !== "running" || !delta) return;
    this.body += delta;
    this.segmentDeltaChars += delta.length;
    this.cardkit?.append(delta);
  }

  /**
   * 轮末的全量文本。
   *
   * 注意：调用方给的是**最后一条 assistant 消息**的正文，不一定是整轮文本。
   * - 长度与 delta 累加对得上（= 整轮）→ 按本段 offset 切开，否则续段会把上一段重印一遍
   * - 对不上（只是最后一条消息）→ 沿用「谁长用谁」：宁可以 delta 累加为准，也不能丢字
   */
  ensureFinal(text: string) {
    if (!text) return;
    const deltaTotal = this.segmentStart + this.segmentDeltaChars;
    if (deltaTotal === text.length || this.segmentDeltaChars === 0) {
      const tail = text.slice(this.segmentStart);
      if (!this.body.trim() || tail.length >= this.body.length) this.body = tail;
    } else {
      debugLog("feishu.reply_card.segment_offset_mismatch", {
        key: this.key,
        runId: this.runId,
        segmentStart: this.segmentStart,
        segmentDeltaChars: this.segmentDeltaChars,
        finalLength: text.length,
      });
      if (!this.body.trim() || text.length >= this.body.length) this.body = text;
    }
    this.cardkit?.ensureFinal(this.body);
  }

  /**
   * feishu_ask 等待期间调用：把当前这一段定格成「等你选择」。
   * 之后 append 会被 status 守卫挡住，正文不会再写进这张卡；
   * 用户答完/超时后由 resume() 开新的一段（新消息）继续输出。
   */
  async pauseForAsk(note = "等你选择") {
    if (this.status !== "running") return;
    this.status = "paused";
    this.note = note;
    // 定格本段：下一段的 offset 从这里开始
    this.segmentStart += this.segmentDeltaChars;
    this.segmentDeltaChars = 0;
    this.segments.push({ messageId: this.segmentMessageId, text: this.body });
    debugLog("feishu.reply_card.paused", {
      key: this.key,
      runId: this.runId,
      segmentStart: this.segmentStart,
      bodyLength: this.body.length,
    });

    if (this.cardkit) {
      await this.cardkit.close(this.body, "paused", note);
      return;
    }
    if (this.segmentMessageId) {
      try {
        await this.transport.updateCard(
          this.segmentMessageId,
          buildReplyCard({
            key: this.key,
            runId: this.runId,
            status: "paused",
            note,
            body: stripLocalImageMarkdown(this.body),
            title: this.title,
          }),
        );
      } catch (error) {
        debugLog("feishu.reply_card.pause_static_error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * 问答结束（作答或超时）后调用：先把暂停的那张卡翻成「已选择」，
   * 再开一段新的「回复中」卡继续输出。
   * 新段标题写「回复（接上条）」，让用户知道它接的是哪一段。
   */
  async resume() {
    if (this.status !== "paused") return;
    await this.markAnswered();
    this.body = "";
    this.note = "承接上一条回复";
    this.title = "回复（接上条）";
    this.status = "running";
    await this.start();
  }

  /** 把暂停卡翻成「已选择」：否则它会永远停在「等你选择」 */
  private async markAnswered() {
    if (this.cardkit) {
      await this.cardkit.updateFinal("answered", this.note);
      return;
    }
    if (!this.segmentMessageId) return;
    try {
      await this.transport.updateCard(
        this.segmentMessageId,
        buildReplyCard({
          key: this.key,
          runId: this.runId,
          status: "answered",
          note: this.note,
          body: stripLocalImageMarkdown(this.body),
          title: this.title,
        }),
      );
    } catch (error) {
      debugLog("feishu.reply_card.answered_static_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async stopImmediately(note = "已停止") {
    await this.finishFinal("stopped", note);
  }

  async finish(status: ReplyCardFinalStatus, note?: string) {
    await this.finishFinal(status, note);
  }

  async completeWithAnswer(answer: string) {
    this.ensureFinal(answer || "（无内容）");
    await this.finishFinal("done", undefined);
  }

  private async finishFinal(
    status: ReplyCardFinalStatus,
    note: string | undefined,
  ) {
    // paused 也要允许收尾：否则「等你选择」的卡永远停在中间态
    if (this.status !== "running" && this.status !== "paused") return;
    await this.renderFinal(status, note);
    // 卡片定稿之后再发图：图挂在下面，不打断流式更新
    const replyToMessageId =
      "replyToMessageId" in this.target ? this.target.replyToMessageId : undefined;
    const chatId = "chatId" in this.target ? this.target.chatId : undefined;
    await flushLocalImages({
      // 这里必须传原文：卡片正文那边已各自 stripLocalImageMarkdown，而 flushLocalImages
      // 要靠 `![](路径)` 才能抽出本地图片。传 strip 后的文本会让它永远抽不到图
      // （2026-10-28 实测：debug.pi.log 里 feishu.reply_card.local_images 事件为 0 次，
      //  用户连续三次反馈「怎么没看到图」）。
      body: this.body,
      status,
      target: { replyToMessageId, chatId },
      transport: this.transport,
    });
  }

  private async renderFinal(
    status: ReplyCardFinalStatus,
    note: string | undefined,
  ) {
    // 已到终态：退出收尾不该再动它（用户可能已经看到完整的最终卡）
    unregisterLiveCard(this);
    const wasPaused = this.status === "paused";
    this.status = status;
    this.note = note ?? defaultFinalNote(status);
    // 中断兜底（必需）：session.abort() 不保证发出 tool_execution_end，
    // 不收尾的话用户按了停止，清单还显示 ⏳，看起来仍在跑。
    // 冻结在 abortAll 之后：轮末残留事件不得再改这份定格的执行记录。
    if (this.tracker.abortAll() > 0) {
      debugLog("feishu.reply_card.progress_aborted", {
        key: this.key,
        runId: this.runId,
        status,
        steps: this.tracker.size,
      });
    }
    this.trackerFrozen = true;

    if (this.cardkit) {
      const mapped = status === "failed" ? "failed" : status === "stopped" ? "stopped" : "done";
      if (wasPaused) {
        // 暂停时就已经收过尾（streaming 已关），这里只需再刷一次 header/正文
        await this.cardkit.updateFinal(mapped, this.note);
        return;
      }
      // 同一张 CardKit 卡上关闭流式并更新 header（回复/已停止/出错了）
      await this.cardkit.close(this.body, mapped, this.note);
      return;
    }

    // 静态卡路径
    if (this.segmentMessageId) {
      try {
        await this.transport.updateCard(
          this.segmentMessageId,
          buildReplyCard({
            key: this.key,
            runId: this.runId,
            status,
            note: status === "done" ? undefined : this.note,
            body: stripLocalImageMarkdown(this.body),
            title: this.title,
          }),
        );
      } catch (error) {
        debugLog("feishu.reply_card.static_final_error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
