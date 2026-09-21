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
import { loadConfig, runtimeEnv } from "./config.ts";
import { debugLog } from "./debug.ts";

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

export type ReplyCardStreamOptions = {
  enabled?: boolean;
  /** CardKit 客户端打印间隔 ms（默认 50） */
  printFrequencyMs?: number;
  /** CardKit 每次打印字符数（默认 1） */
  printStep?: number;
  /** 服务端推送 fullText 到 CardKit 的间隔 ms（默认 120） */
  pushIntervalMs?: number;
};

type ReplyCardTransport = {
  replyCard(messageId: string, card: object): Promise<string | undefined>;
  updateCard(messageId: string, card: object): Promise<void>;
  /** 平铺发送一张卡片（非话题群默认路径） */
  createCard?(chatId: string, card: object): Promise<string | undefined>;
  replyPlainText?(messageId: string, text: string): Promise<string | undefined>;
  updateText?(messageId: string, text: string): Promise<void>;
  /** 记录本 bot 出站消息，供 groupAlsoOnReply */
  rememberOutboundMessageId?(messageId: string): void;
};

function resolveStreamOptions(override?: ReplyCardStreamOptions) {
  const cfg = loadConfig();
  return {
    enabled: override?.enabled ?? cfg?.streamingReply !== false,
    printFrequencyMs: Math.max(
      20,
      override?.printFrequencyMs
        ?? parseEnvInt("FEISHU_STREAM_PRINT_FREQUENCY_MS")
        ?? cfg?.streamPrintFrequencyMs
        ?? 50,
    ),
    printStep: Math.max(
      1,
      override?.printStep
        ?? parseEnvInt("FEISHU_STREAM_PRINT_STEP")
        ?? cfg?.streamPrintStep
        ?? 1,
    ),
    pushIntervalMs: Math.max(
      50,
      override?.pushIntervalMs
        ?? parseEnvInt("FEISHU_STREAM_PUSH_INTERVAL_MS")
        ?? cfg?.streamPushIntervalMs
        ?? 120,
    ),
  };
}

function parseEnvInt(name: string): number | undefined {
  const v = runtimeEnv(name)?.trim();
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

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
          onOutboundMessageId: (id) => {
            this.segmentMessageId = id;
            this.transport.rememberOutboundMessageId?.(id);
          },
        },
      );
      debugLog("feishu.reply_card.cardkit_ready", {
        key: this.key,
        runId: this.runId,
        ...this.streamOpts,
      });
      // 先让飞书看到「回复中」，不等待 Pi 产出第一段正文；失败仍会在结束时回落为普通回复卡。
      void this.cardkit.startImmediately();
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

  updateFromEvent(_event: unknown) {
    // 不展示过程
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
            body: this.body,
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
          body: this.body,
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
    const wasPaused = this.status === "paused";
    this.status = status;
    this.note = note ?? defaultFinalNote(status);

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
            body: this.body,
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
