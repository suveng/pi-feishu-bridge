/**
 * 外部唤醒轮的兜底回复卡。
 *
 * 背景：桥接只给「飞书消息驱动的一轮」（`prompt` / `promptWithImages`）建卡。
 * 异步子 agent 跑完、后台任务回传、`bg_wait` 唤醒这些场景会**让同一个会话再跑一轮**，
 * 但那一轮没有 prompt 调用方：`activeRuns` 里没有它，`text_delta` 被直接丢弃
 * （PiConversationRuntime 里 `if (delta && run && !run.stopped)` 的 else 分支），
 * 于是用户永远收不到「结果出来了」这条通知。
 *
 * 本控制器只看会话级事件流，按「轮次起点 → 增量 → 轮次终点」把那段输出接成一张流式卡片：
 * - 起点：`agent_start` 且当前没有 prompt 占用（外部唤醒轮的明确起点）；
 * - 增量：`message_update` 的 text_delta，先攒着，第一段文本到达才真正开卡
 *   （纯工具轮不建卡，避免给用户弹一张空卡）；
 * - 终点：`agent_end` / `agent_settled`，用会话里最后一条 assistant 文本定稿收尾。
 *
 * 两个守卫：
 * - **孤儿增量守卫**：没有 `agent_start` 的增量（迟到事件）距上一轮 prompt 结束太近就忽略，
 *   否则会把上一轮尾巴重复写进一张新卡；
 * - **陈旧轮守卫**：一轮活过 `maxTurnMs` 视为异常（丢事件），先收尾再重开，不让卡片永久挂在「回复中」。
 */

/** 兜底卡只用到这三件事，保持与 ReplyCard 解耦，便于单测注入假实现 */
export type ExternalCardSink = {
  append(delta: string): void;
  ensureFinal(text: string): void;
  finish(status: "done" | "failed" | "stopped", note?: string): Promise<void>;
};

/** 开卡能力由适配器注入（需要飞书连接与路由，Runtime 层不直接碰） */
export type ExternalCardOpener = (
  key: string,
  meta: { reason: ExternalTurnReason },
) => Promise<ExternalCardSink | undefined>;

export type ExternalTurnReason = "agent_start" | "orphan_delta";

export type ExternalCardOptions = {
  /** 无 agent_start 的孤立增量：距上一轮 prompt 结束不足该时长就忽略 */
  orphanDeltaGuardMs?: number;
  /** 单轮最长存活时间，超过视为丢事件，先收尾再重开 */
  maxTurnMs?: number;
  now?: () => number;
  log?: (event: string, data?: Record<string, unknown>) => void;
};

type ExternalTurnState = {
  startedAt: number;
  reason: ExternalTurnReason;
  /** 卡片还没建好时先攒文本，建好后一次性补写，避免丢开头几个字 */
  pending: string;
  sink?: ExternalCardSink;
  opening?: Promise<void>;
  /** 开卡尝试失败的次数：用于抑制重复日志（拿不到 transport/route 时，每个增量都会再试一次） */
  openFailures: number;
  closed: boolean;
};

const DEFAULT_ORPHAN_GUARD_MS = 2_000;
const DEFAULT_MAX_TURN_MS = 30 * 60_000;

export class ExternalCardController {
  private readonly turns = new Map<string, ExternalTurnState>();
  private readonly lastPromptEndAt = new Map<string, number>();
  private readonly opener: () => ExternalCardOpener | undefined;
  private readonly orphanGuardMs: number;
  private readonly maxTurnMs: number;
  private readonly now: () => number;
  private readonly log: (event: string, data?: Record<string, unknown>) => void;

  constructor(opener: () => ExternalCardOpener | undefined, options: ExternalCardOptions = {}) {
    this.opener = opener;
    this.orphanGuardMs = options.orphanDeltaGuardMs ?? DEFAULT_ORPHAN_GUARD_MS;
    this.maxTurnMs = options.maxTurnMs ?? DEFAULT_MAX_TURN_MS;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
  }

  /** prompt 轮结束记时间戳：给孤儿增量守卫用 */
  notePromptEnd(key: string) {
    this.lastPromptEndAt.set(key, this.now());
  }

  has(key: string): boolean {
    return this.turns.has(key);
  }

  /**
   * 开启一轮（或确认已有轮）。
   * `agent_start` 上升沿直接开；孤儿增量要过冷却守卫。
   * @returns 是否已处于一轮外部轮里（false = 这条事件不该写卡）
   */
  begin(key: string, reason: ExternalTurnReason): boolean {
    const now = this.now();
    const existing = this.turns.get(key);
    if (existing) {
      if (now - existing.startedAt < this.maxTurnMs) return true;
      // 陈旧轮：先收尾再重开，否则新输出会写进一张早已没人看的卡
      this.log("feishu.external_card.stale_turn", { key, ageMs: now - existing.startedAt });
      void this.end(key, () => "");
    } else if (reason === "orphan_delta") {
      const endedAt = this.lastPromptEndAt.get(key) ?? 0;
      if (now - endedAt < this.orphanGuardMs) {
        this.log("feishu.external_card.orphan_delta_ignored", { key, sincePromptEndMs: now - endedAt });
        return false;
      }
    }
    if (!this.turns.has(key)) {
      this.turns.set(key, { startedAt: now, reason, pending: "", openFailures: 0, closed: false });
      this.log("feishu.external_card.turn_start", { key, reason });
    }
    return true;
  }

  /** 文本增量；返回 true 表示已接住（写进卡或攒在待开卡缓冲里） */
  observeDelta(key: string, delta: string): boolean {
    if (!delta) return false;
    if (!this.turns.has(key) && !this.begin(key, "orphan_delta")) return false;
    const state = this.turns.get(key);
    if (!state || state.closed) return false;
    if (state.sink) state.sink.append(delta);
    else {
      state.pending += delta;
      this.ensureCard(key, state);
    }
    return true;
  }

  /** 轮次结束：把最后一条 assistant 文本定稿后收尾；整轮无文本则不发卡 */
  async end(key: string, readFinalText: () => string): Promise<void> {
    const state = this.turns.get(key);
    if (!state) return;
    this.turns.delete(key);
    state.closed = true;
    if (state.opening) {
      try {
        await state.opening;
      } catch {}
    }
    const sink = state.sink;
    if (!sink) {
      // 纯工具轮 / 空轮：不弹空卡，只留日志
      this.log("feishu.external_card.empty_turn", { key, reason: state.reason });
      return;
    }
    let finalText = "";
    try {
      finalText = readFinalText() || "";
    } catch (error) {
      this.log("feishu.external_card.final_text_failed", { key, error: errorMessage(error) });
    }
    try {
      if (finalText) sink.ensureFinal(finalText);
      await sink.finish("done");
      this.log("feishu.external_card.finished", {
        key,
        reason: state.reason,
        textLength: finalText.length,
        durationMs: this.now() - state.startedAt,
      });
    } catch (error) {
      this.log("feishu.external_card.finish_failed", { key, error: errorMessage(error) });
      try {
        await sink.finish("failed", errorMessage(error));
      } catch {}
    }
  }

  /** 惰性开卡：只在第一段文本到达时调用，且同一轮只开一次 */
  private ensureCard(key: string, state: ExternalTurnState) {
    if (state.sink || state.opening || state.closed) return;
    const opener = this.opener();
    if (!opener) {
      this.log("feishu.external_card.opener_missing", { key });
      return;
    }
    state.opening = (async () => {
      const sink = await opener(key, { reason: state.reason });
      if (!sink) {
        state.openFailures += 1;
        // 只记第一条：拿不到 transport/route 时每个增量都会重试，日志不能刷屏
        if (state.openFailures === 1) {
          this.log("feishu.external_card.open_skipped", { key, reason: state.reason });
        }
        return;
      }
      if (state.closed) {
        // 开卡比收尾还慢（极端竞态）：这一轮已经结束，直接把卡收掉，别留一张「回复中」
        sink.ensureFinal(state.pending);
        await sink.finish("done");
        return;
      }
      state.sink = sink;
      const buffered = state.pending;
      state.pending = "";
      if (buffered) sink.append(buffered);
      this.log("feishu.external_card.opened", { key, reason: state.reason, bufferedChars: buffered.length });
    })()
      .catch((error) => {
        state.openFailures += 1;
        if (state.openFailures === 1) {
          this.log("feishu.external_card.open_failed", { key, error: errorMessage(error) });
        }
      })
      .finally(() => {
        state.opening = undefined;
      });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
