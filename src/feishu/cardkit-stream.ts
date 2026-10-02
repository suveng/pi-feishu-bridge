/**
 * 飞书 CardKit 真正的流式卡片：
 * streaming_mode + print_frequency_ms/print_step 由客户端逐字打印。
 * 我们侧只需定期 PUT 完整 markdown 内容。
 * running 卡必须带「停止」按钮（与 card-builder 契约一致）。
 */
import { buildCardKitCardJson, type ReplyCardStatus } from "./card-builder.ts";
import { byteLength } from "./progress-note.ts";
import { sendOversizeProgressCard } from "./oversize-progress-card.ts";
import { debugLog } from "./debug.ts";
import { withRetry } from "./retry.ts";

type CardKitResponse = { code: number; msg: string; data?: any };

/**
 * 卡片发到哪里：
 * - chatId：平铺成一条新消息（默认；多条 reply 会被飞书折叠成同一个回复簇，后到的盖住先到的）
 * - replyToMessageId：回复某条消息（话题群/回复链必须用这个，否则会新开话题）
 */
export type CardKitTarget = { chatId: string } | { replyToMessageId: string };

/** CardKit 卡片可写入的状态（paused/answered 是中间态，允许重复全量更新） */
export type CardKitCardStatus = Extract<
  ReplyCardStatus,
  "running" | "paused" | "answered" | "done" | "stopped" | "failed"
>;

export type CardKitStreamOptions = {
  /** 客户端打印频率 ms（默认 50，越小越跟手） */
  printFrequencyMs?: number;
  /** 客户端每次打印字符数（默认 1 = 逐字） */
  printStep?: number;
  /** 服务端把 fullText 推到 CardKit 的间隔 ms（默认 120） */
  pushIntervalMs?: number;
  /** 会话 key，用于停止按钮回调 */
  conversationKey?: string;
  /** 本轮 runId，用于停止按钮回调 */
  runId?: string;
  /** 覆盖卡片默认标题（续段用「回复（接上条）」） */
  title?: string;
  /** 卡片正文上方的说明（续段用来交代「承接上一条回复」） */
  note?: string;
  /**
   * 是否在卡片上预留工具过程清单元件（element_id: progress）。
   * true 时建卡即插入该元件：CardKit 只能按 element_id 更新已存在的元件，
   * 建卡时不留位，后续再想写清单就 PUT 不上去。
   */
  progressEnabled?: boolean;
  /** 记录本 bot 发出的消息 id（供 groupAlsoOnReply） */
  onOutboundMessageId?: (messageId: string) => void;
};

export class CardKitStream {
  private cardId: string | null = null;
  private fullText = "";
  private lastSent = "";
  /** 工具过程清单（element_id: progress），与正文各走一条 PUT */
  private progressText = "";
  /** 清单取数回调；tick 时调用，不在事件里直接写 */
  private progressSource: (() => string) | undefined;
  /** 上一次成功写上去的清单原文；null = 从未写过 */
  private lastProgressSent: string | null = null;
  private token: string | null = null;
  private tokenExpiry = 0;
  private sequence = 1;
  private interval: ReturnType<typeof setInterval> | null = null;
  private startPromise: Promise<void> | null = null;
  private closed = false;
  private failed = false;
  private readonly printFrequencyMs: number;
  private readonly printStep: number;
  private readonly pushIntervalMs: number;
  private readonly conversationKey?: string;
  private readonly runId?: string;
  private readonly title?: string;
  private readonly note?: string;
  private readonly progressEnabled: boolean;
  private readonly onOutboundMessageId?: (messageId: string) => void;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly domain: "feishu" | "lark";
  private readonly target: CardKitTarget;
  private readonly fallbackReply: (text: string) => Promise<void>;

  constructor(
    appId: string,
    appSecret: string,
    domain: "feishu" | "lark",
    target: string | CardKitTarget,
    fallbackReply: (text: string) => Promise<void>,
    options?: CardKitStreamOptions,
  ) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.domain = domain;
    this.target = typeof target === "string" ? { replyToMessageId: target } : target;
    this.fallbackReply = fallbackReply;
    this.printFrequencyMs = Math.max(20, options?.printFrequencyMs ?? 50);
    this.printStep = Math.max(1, options?.printStep ?? 1);
    this.pushIntervalMs = Math.max(50, options?.pushIntervalMs ?? 120);
    this.conversationKey = options?.conversationKey;
    this.runId = options?.runId;
    this.title = options?.title;
    this.note = options?.note;
    this.progressEnabled = options?.progressEnabled === true;
    this.onOutboundMessageId = options?.onOutboundMessageId;
  }

  private baseUrl() {
    return this.domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  }

  private async getToken(): Promise<string> {
    if (this.token && this.tokenExpiry > Date.now() + 60_000) return this.token!;
    const res = await fetch(`${this.baseUrl()}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const j = (await res.json()) as CardKitResponse & { tenant_access_token?: string; expire?: number };
    if (j.code !== 0 || !j.tenant_access_token) throw new Error(`token: ${j.msg || res.status}`);
    this.token = j.tenant_access_token;
    this.tokenExpiry = Date.now() + (j.expire ?? 7200) * 1000;
    return this.token!;
  }

  private async start(): Promise<void> {
    if (this.closed || this.cardId || this.failed) return;
    await withRetry(async () => {
      const t = await this.getToken();
      // 必须带停止按钮；禁止只建 markdown 导致无法中止
      const card = buildCardKitCardJson({
        status: "running",
        body: "",
        key: this.conversationKey,
        runId: this.runId,
        title: this.title,
        note: this.note,
        // 建卡时就留好清单位（此时清单多半还是空的，但后面要往里 PUT）
        progress: this.progressEnabled ? this.currentProgress() : undefined,
        streaming: true,
        printFrequencyMs: this.printFrequencyMs,
        printStep: this.printStep,
      });

      const cr = await fetch(`${this.baseUrl()}/open-apis/cardkit/v1/cards`, {
        method: "POST",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "card_json", data: JSON.stringify(card) }),
      });
      const c = (await cr.json()) as CardKitResponse;
      if (c.code !== 0 || !c.data?.card_id) {
        throw Object.assign(new Error(`create_card: ${c.msg || c.code}`), { code: c.code });
      }
      this.cardId = c.data.card_id as string;

      // 平铺（create）还是回复（reply）：多条 reply 会被飞书折叠，见 CardKitTarget 说明
      const isCreate = "chatId" in this.target;
      const sendUrl = isCreate
        ? `${this.baseUrl()}/open-apis/im/v1/messages?receive_id_type=chat_id`
        : `${this.baseUrl()}/open-apis/im/v1/messages/${(this.target as { replyToMessageId: string }).replyToMessageId}/reply`;
      const sr = await fetch(sendUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(isCreate ? { receive_id: (this.target as { chatId: string }).chatId } : {}),
          msg_type: "interactive",
          content: JSON.stringify({ type: "card", data: { card_id: this.cardId } }),
        }),
      });
      const s = (await sr.json()) as CardKitResponse & { data?: { message_id?: string } };
      if (s.code !== 0) {
        throw Object.assign(new Error(`send_card: ${s.msg || s.code}`), { code: s.code });
      }
      const outboundId = s.data?.message_id;
      if (outboundId) this.onOutboundMessageId?.(outboundId);
      debugLog("feishu.cardkit.started", {
        cardId: this.cardId,
        messageId: outboundId,
        mode: isCreate ? "create" : "reply",
        printFrequencyMs: this.printFrequencyMs,
        printStep: this.printStep,
      });
    }, { maxRetries: 2, label: "feishu.cardkit.start" });

    // 如果在建卡期间本轮回复已结束，close() 会负责把卡收尾；这里无需再留下定时推送。
    if (!this.closed && !this.interval) {
      this.interval = setInterval(() => {
        void this.tick();
      }, this.pushIntervalMs);
    }
  }

  /**
   * 收到用户消息后立刻创建唯一的一张「回复中」卡。
   * 不等待首段正文，避免用户把较慢的 Pi 回复误认为卡住了。
   */
  startImmediately(): Promise<void> {
    if (this.closed || this.failed || this.cardId) return Promise.resolve();
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.start()
      .catch((e) => {
        this.failed = true;
        debugLog("feishu.cardkit.start_error", {
          error: e instanceof Error ? e.message : String(e),
        });
      })
      .finally(() => {
        this.startPromise = null;
      });
    return this.startPromise;
  }

  /** 同步攒字；建卡已在收到消息时提前触发，这里只保证未漏启动。 */
  append(delta: string): void {
    if (this.closed || this.failed || !delta) return;
    this.fullText += delta;
    void this.startImmediately();
  }

  ensureFinal(text: string): void {
    if (!text) return;
    if (!this.fullText.trim() || text.length >= this.fullText.length) {
      this.fullText = text;
    }
  }

  /**
   * 设置过程清单的取数函数。
   *
   * 用回调而不是一次性的字符串：timeout / action 档的「已执行 Ns」必须随时间长，
   * 而 Pi 在单个工具运行期间不发任何事件，只有 tick 能驱动刷新。
   * 回调方（ProgressTracker）已把耗时量化到 5 秒粒度，因此文本不会每个 tick 都变。
   */
  setProgressSource(source: (() => string) | undefined): void {
    if (!this.progressEnabled) return;
    this.progressSource = source;
  }

  /** 取当前清单文本（回调异常不影响卡片推送） */
  private currentProgress(): string {
    if (!this.progressSource) return "";
    try {
      return this.progressSource();
    } catch (e) {
      debugLog("feishu.cardkit.progress_source_error", {
        error: e instanceof Error ? e.message : String(e),
      });
      return this.progressText;
    }
  }

  private async tick() {
    if (!this.cardId || this.closed) return;
    await this.putElementText("content", this.fullText);
    if (this.progressEnabled) await this.putElementText("progress", this.currentProgress());
  }

  /**
   * 写入某个元件的文本（全量）。
   *
   * content 是正文元件，progress 是过程清单元件 —— 两者只有 URL、空值处理和去重键不同，
   * 所以合并成一条路径；sequence 也必须是同一个递增计数器
   * （飞书要求同一张卡上所有操作的 sequence 严格递增）。
   */
  private async putElementText(elementId: "content" | "progress", text: string) {
    if (!this.cardId) return;
    // 飞书不接受空内容，空清单用一个空格占位
    const content = elementId === "progress" ? text.trim() || " " : text;
    // 去重键统一用「实际发出去的 content」：progress 的原文可能带空白，用它比较会重复发送
    const lastSent = elementId === "progress" ? this.lastProgressSent : this.lastSent;
    if (content === lastSent) return;
    try {
      const t = await this.getToken();
      const seq = ++this.sequence;
      const res = await fetch(
        `${this.baseUrl()}/open-apis/cardkit/v1/cards/${this.cardId}/elements/${elementId}/content`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            content,
            sequence: seq,
            uuid: `${this.cardId}_${elementId}_${seq}`,
          }),
        },
      );
      if (!res.ok) {
        debugLog("feishu.cardkit.element_error", {
          elementId,
          seq,
          status: res.status,
          body: (await res.text()).slice(0, 200),
        });
        return;
      }
      if (elementId === "progress") this.lastProgressSent = content;
      else this.lastSent = content;
    } catch (e) {
      debugLog("feishu.cardkit.element_throw", {
        elementId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * 结束流式：
   * 1) 推送最终正文
   * 2) 关闭 streaming_mode（只做一次）
   * 3) 全量更新卡片（header 改为「回复」/绿，避免一直停在「回复中」）
   *
   * 可重复调用：暂停（paused）之后这张卡还要刷成终态，那一步走 updateFinal。
   */
  async close(
    finalText?: string,
    finalStatus: CardKitCardStatus = "done",
    note?: string,
  ): Promise<void> {
    if (finalText) this.ensureFinal(finalText);
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.startPromise) await this.startPromise.catch(() => {});

    const firstClose = !this.closed;
    this.closed = true;

    if (this.failed || !this.cardId) {
      if (this.fullText.trim()) {
        debugLog("feishu.cardkit.fallback_text", { length: this.fullText.length });
        await this.fallbackReply(this.fullText);
      }
      return;
    }

    try {
      if (firstClose) {
        await this.putElementText("content", this.fullText);
        // 清单必须赶在关流式之前写：关掉 streaming_mode 后这条接口就不能再用了
        if (this.progressEnabled) await this.putElementText("progress", this.currentProgress());
        // 给客户端一点时间把剩余字符打完
        await sleep(Math.max(200, this.printFrequencyMs * 4));
        await this.stopStreaming();
      }
      // putFinalCard 失败意味着卡片会永远停在「回复中」，补一条只带清单的消息
      if (!(await this.putFinalCard(finalStatus, note))) {
        await this.sendOversizeFallback(finalStatus);
      }
    } catch (e) {
      debugLog("feishu.cardkit.close_error", {
        error: e instanceof Error ? e.message : String(e),
      });
      if (this.fullText.trim()) await this.fallbackReply(this.fullText);
    }
  }

  /**
   * 全量更新卡片（流式已关也能再刷）。
   * 暂停卡要能翻成「已选择 / 已停止」，否则会永远停在「等你选择」。
   */
  async updateFinal(finalStatus: CardKitCardStatus, note?: string): Promise<void> {
    try {
      if (!(await this.putFinalCard(finalStatus, note))) {
        await this.sendOversizeFallback(finalStatus);
      }
    } catch (e) {
      debugLog("feishu.cardkit.full_update_throw", {
        status: finalStatus,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** 关闭 streaming_mode（只做一次） */
  private async stopStreaming(): Promise<void> {
    const t = await withRetry(() => this.getToken(), {
      maxRetries: 3,
      label: "feishu.cardkit.close_token",
    });

    // 收尾这一步必须重试：CardKit 卡的 header 还是「回复中」，
    // 一次 fetch failed 就会让这张卡永远停在「回复中」，只能靠人手动忽略。
    const settingsRes = await withRetry(() =>
      fetch(`${this.baseUrl()}/open-apis/cardkit/v1/cards/${this.cardId}/settings`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: JSON.stringify({
            config: {
              streaming_mode: false,
              summary: { content: (this.fullText.slice(0, 50) || "Pi").replace(/\s+/g, " ") },
            },
          }),
          sequence: ++this.sequence,
          uuid: `c_${this.cardId}_${this.sequence}`,
        }),
      }),
      { maxRetries: 3, label: "feishu.cardkit.close_settings" },
    );
    if (!settingsRes.ok) {
      debugLog("feishu.cardkit.settings_error", {
        status: settingsRes.status,
        body: (await settingsRes.text()).slice(0, 300),
      });
    }
  }

  /**
   * 全量更新卡片正文与 header（不做流式收尾，可重复调用）。
   * 返回是否更新成功：失败时调用方要跑兜底流程（整卡超 30KB 时卡片会一直停在「回复中」）。
   */
  private async putFinalCard(finalStatus: CardKitCardStatus, note?: string): Promise<boolean> {
    if (!this.cardId) return false;
    const t = await withRetry(() => this.getToken(), {
      maxRetries: 3,
      label: "feishu.cardkit.close_token",
    });
    const finalCard = buildCardKitCardJson({
      status: finalStatus,
      body: this.fullText,
      note,
      key: this.conversationKey,
      runId: this.runId,
      title: this.title,
      streaming: false,
      // 终态卡保留定格后的清单，让用户能回看这一轮干了什么
      progress: this.progressEnabled ? this.currentProgress() : undefined,
    });
    const updateRes = await withRetry(() =>
      fetch(`${this.baseUrl()}/open-apis/cardkit/v1/cards/${this.cardId}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          card: {
            type: "card_json",
            data: JSON.stringify(finalCard),
          },
          sequence: ++this.sequence,
          uuid: `u_${this.cardId}_${this.sequence}`,
        }),
      }),
      { maxRetries: 3, label: "feishu.cardkit.close_update" },
    );
    const updateJson = (await updateRes.json().catch(() => ({}))) as CardKitResponse;
    if (!updateRes.ok || (updateJson.code != null && updateJson.code !== 0)) {
      debugLog("feishu.cardkit.full_update_error", {
        status: updateRes.status,
        code: updateJson.code,
        msg: updateJson.msg,
        bodyBytes: byteLength(this.fullText),
        progressBytes: byteLength(this.currentProgress()),
      });
      return false;
    }

    debugLog("feishu.cardkit.closed", {
      cardId: this.cardId,
      length: this.fullText.length,
      finalStatus,
      headerTitle: (finalCard as any).header?.title?.content,
      hasStopButton: JSON.stringify(finalCard).includes("停止"),
    });
    return true;
  }

  /**
   * 整卡更新失败时的兜底：交给 oversize-progress-card 新发一条只带清单的消息。
   *
   * 背景：正文本就是撑爆整卡（≤ 30KB）的主因，而正文用户已经从流式输出里看完了，
   * 真正丢掉的是「这轮结束了」和清单 —— 用一条体积可控的新消息补回来。
   */
  private async sendOversizeFallback(finalStatus: CardKitCardStatus): Promise<void> {
    if (!this.progressEnabled) return;
    await sendOversizeProgressCard({
      baseUrl: this.baseUrl(),
      getToken: () => this.getToken(),
      target: this.target,
      conversationKey: this.conversationKey,
      runId: this.runId,
      title: this.title,
      finalStatus,
      progress: this.currentProgress(),
      onOutboundMessageId: this.onOutboundMessageId,
    });
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
