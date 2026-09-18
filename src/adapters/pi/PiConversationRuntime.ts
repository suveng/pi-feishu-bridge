import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import * as PiSdk from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentSession, SessionInfo } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { FeishuBridgeRuntime, BridgeJobEvent } from "../../feishu/bridge-runtime.ts";
import { CHILD_SESSION_ENV, ensureRoot, loadConfig, readJson, STATE_PATH, writeJson } from "../../feishu/config.ts";
import { debugLog } from "../../feishu/debug.ts";
import { waitForPrompt } from "../../feishu/prompt-timeout.ts";
import type { ResumeScope, ResumeSessionPage } from "../../feishu/cards.ts";
import type { ReplyCardSink } from "../../feishu/reply-card.ts";
import { normalizeThinkingLevels, type ThinkingStatus } from "../../feishu/thinking.ts";
import type { FeishuState } from "../../feishu/types.ts";
import type { ConversationRuntime, ConversationStatus, ContextUsage, RuntimeModel, StopConversationResult, ConversationTimeouts } from "../../feishu/runtime.ts";
import type { FeishuUiNotifyPayload } from "../../feishu/ui-notify.ts";
import {
  buildAskCard,
  cancelAsk,
  registerAsk,
  setAskCardMessage,
  type AskOutcome,
  type AskQuestion,
} from "../../feishu/ask.ts";
import { ensureWorkspaceExists, resolveWorkspacePath } from "../../feishu/workspace.ts";
import { formatApprovalOutcome, type LearnApprovalResult } from "../../feishu/learn-approval.ts";

/**
 * Pi Runtime 适配器：
 * 把飞书公共层需要的会话能力映射到 Pi 的 AgentSession API。
 * 第一阶段保持与原 ConversationManager 完全一致的行为。
 */

type ActiveRun = {
  session: AgentSession;
  runId?: string;
  stopped: boolean;
  status?: ReplyCardSink;
  /** 当前轮流式回调（由 promptWithImages 设置） */
  onDelta?: (delta: string) => void;
};

type ModelRuntimeAdapter = {
  getModel(provider: string, id: string): any;
  hasConfiguredAuth(model: any): boolean;
  getAvailable(): Promise<any[]>;
  sessionOptions: Record<string, unknown>;
};

const RESUME_PAGE_SIZE = 10;

/**
 * 扩展命令派发后的启动观察窗口（ms）：命令处理器内部调用 pi.sendUserMessage
 * 触发模型轮次，挂上是异步的。在这个窗口内轮询“是否已经跑起来”，
 * 跑起来就提前退出；只读命令（不触发模型）会等满这个窗口。
 */
const COMMAND_STARTUP_WINDOW_MS = 1000;

/**
 * 需要交回 Pi 做扩展命令派发的斜杠命令（不含前导斜杠）。
 *
 * 默认所有斜杠文本都透传给模型：用户在飞书里打 `/kb 查 xxx` 本意是「问一句」，
 * 若被 Pi 当成 knowledge-flow 的 /kb 命令吃掉，只会跑全文检索，那句问题根本到不了模型。
 *
 * 这里的命令属于反例：它们明确是「执行一个流程」而不是「问一个问题」，
 * 模型收到字面文本也做不了，必须交回 Pi 派发。
 * 命令名必须与 `knowledge-flow` 里 `pi.registerCommand()` 的名字一致。
 */
const DISPATCHED_SLASH_COMMANDS = ["learn", "deploy-test"] as const;

/** 判断本轮文本是否要派发（而不是透传给模型）：只看首个空白前的命令名 */
function shouldDispatchSlashCommand(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return false;
  const name = trimmed.slice(1).split(/\s+/)[0] || "";
  return (DISPATCHED_SLASH_COMMANDS as readonly string[]).includes(name);
}

export class PiConversationRuntime implements ConversationRuntime {
  private readonly sessions = new Map<string, Promise<AgentSession>>();
  private readonly sessionFileStats = new Map<string, { mtimeMs: number; size: number }>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private modelRuntimePromise: Promise<ModelRuntimeAdapter> | undefined;
  private defaultProvider: string | undefined;
  private defaultModelId: string | undefined;
  private state: FeishuState;
  private readonly cwd: string;
  private readonly bridge?: FeishuBridgeRuntime;
  private readonly timeouts: ConversationTimeouts;
  /**
   * 正在被飞书驱动、且可能产生扩展 UI 输出的会话 key（后进先出）。
   * 扩展的 notify 事件不带会话信息，只能路由到「最近一次飞书发起的轮次」。
   */
  private readonly activeTurnKeys: string[] = [];
  /** 轮次期间收到的扩展 notify 文本；模型没产出答案时作为兜底输出 */
  private readonly uiNotifyBuffers = new Map<string, string[]>();
  /**
   * 发送「选择题」卡片的能力，由适配器注入（需要 transport，Runtime 层不直接碰飞书连接）。
   * 参数是当前会话 key 与卡片 JSON；返回卡片消息 ID（拿不到就不返回），
   * 超时后要用它原地刷新同一张卡。
   */
  private askSender?: (key: string, card: object) => Promise<string | undefined>;
  /** 原地刷新提问卡片的能力（patch 同一条消息），由适配器注入 */
  private askCardUpdater?: (messageId: string, card: object) => Promise<void>;
  /**
   * 发起「进化审批」的能力，由适配器注入（需要飞书连接与审批配置，Runtime 层不直接碰）。
   * 传当前会话 key 与候选点正文，返回审批结果。
   */
  private learnApprovalRequester?: (key: string, body: string) => Promise<LearnApprovalResult>;

  /** 由适配器注入卡片发送器（飞书连接就绪后调用） */
  setAskSender(sender: (key: string, card: object) => Promise<string | undefined>) {
    this.askSender = sender;
  }

  /** 由适配器注入进化审批发起器（飞书连接就绪后调用） */
  setLearnApprovalRequester(requester: (key: string, body: string) => Promise<LearnApprovalResult>) {
    this.learnApprovalRequester = requester;
  }

  /** 由适配器注入卡片更新器：超时后把卡片刷成「已超时」用 */
  setAskCardUpdater(updater: (messageId: string, card: object) => Promise<void>) {
    this.askCardUpdater = updater;
  }

  constructor(
    cwd: string,
    bridge?: FeishuBridgeRuntime,
    timeouts: ConversationTimeouts = {},
  ) {
    this.cwd = cwd;
    this.bridge = bridge;
    this.timeouts = timeouts;
    ensureRoot();
    this.state = readJson<FeishuState>(STATE_PATH, { sessions: {} });
    this.state.sessions ||= {};
    this.state.models ||= {};
    this.state.workspaces ||= {};
    this.loadSettingsDefault();
  }

  /** Read global settings default model for fallback in getSelectedModel. */
  private loadSettingsDefault() {
    try {
      const settingsPath = join(getAgentDir(), "settings.json");
      const raw = readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(raw);
      if (settings.defaultProvider && settings.defaultModel) {
        this.defaultProvider = settings.defaultProvider;
        this.defaultModelId = settings.defaultModel;
      }
    } catch {}
  }

  async prompt(key: string, userText: string, onReply: (text: string) => Promise<void>, onDelta?: (delta: string) => void) {
    return this.promptWithImages(key, userText, [], onReply, undefined, onDelta);
  }

  async promptWithImages(
    key: string,
    userText: string,
    images: Array<{ type: "image"; data: string; mimeType: string }>,
    onReply: (text: string) => Promise<void>,
    status?: ReplyCardSink,
    onDelta?: (delta: string) => void,
  ) {
    // 生成中又收到新消息的处理策略（全局运行时配置 messageDelivery）：
    // queue（默认）= 只排队等上一轮跑完；interrupt = 同时掰掉上一轮，让它快速收敛后再跑本轮。
    // 关键：interruptActiveRun 用 void 发起（不 await）。本轮必须同步完成队列占位，
    // 否则两条消息可能同时开跑，撞上 Pi 的 "Agent is already processing"。
    const interrupt = this.isInterruptDelivery();
    if (interrupt) void this.interruptActiveRun(key);
    const runTurn = async () => {
      debugLog("feishu.prompt.start", { key, textLength: userText.length, imageCount: images.length });
      // 斜杠命令透传留痕：桥接自身不认的命令（如 /kb 查、/req 新）连同 `/` 原样交给模型，
      // 不交给 Pi 的扩展命令机制（见 runPromptWithTimeouts 里的 expandPromptTemplates: false）；
      // 日志里能看到即证明已进入本轮 prompt。
      const forwarded = userText.trimStart();
      if (forwarded.startsWith("/")) {
        debugLog("feishu.command.forwarded", { key, command: forwarded.split(/\s+/)[0] });
      }
      const session = await this.ensureSessionFresh(key);
      const run: ActiveRun = { session, runId: status?.runId, stopped: false, status, onDelta };
      this.activeRuns.set(key, run);
      this.bridge?.beginFeishuInput(session.sessionId);
      this.enterFeishuTurn(key);
      /**
       * 派发前的消息条数。扩展命令可能完全不触发模型轮次（如 /req 状态），
       * 那时会话里最后一条 assistant 是**上一轮**的陈旧内容，不能当本轮答案。
       */
      const baselineMessageCount = session.messages?.length ?? 0;
      /** 本轮收到的扩展 notify 文本（如 /req 状态 的输出），模型无答案时兜底 */
      let uiNotifyText = "";
      // 流式走 session 级订阅（createSession 里）→ run.onDelta，避免漏事件
      let unsub: (() => void) | undefined;
      let deltaCount = 0;
      let deltaChars = 0;
      if (onDelta) {
        const userOnDelta = onDelta;
        run.onDelta = (delta: string) => {
          deltaCount += 1;
          deltaChars += delta.length;
          userOnDelta(delta);
        };
      }
      try {
        try {
          await this.runPromptWithTimeouts(session, userText, images, key, onReply, status);
          // 先收 notify（只读命令在处理函数里同步发出），再等命令另行触发的模型轮次跑完
          uiNotifyText = this.drainUiNotify(key);
          await this.settleForwardedCommand(session, userText, key, baselineMessageCount);
        } catch (error) {
          if (run.stopped) {
            debugLog("feishu.prompt.stopped", { key });
            return;
          }
          throw error;
        }
      } finally {
        try { unsub?.(); } catch {}
        run.onDelta = undefined;
        if (this.activeRuns.get(key) === run) this.activeRuns.delete(key);
        this.bridge?.endFeishuInput(session.sessionId);
        this.recordSessionFileStat(key, session.sessionFile);
        this.exitFeishuTurn(key);
      }
      if (run.stopped) return;
      // 会话没有新增消息 = 本轮没跑模型，上一轮的 assistant 文本必须丢弃；
      // 此时只有扩展 notify 的输出可用（只读命令如 /req 状态 全靠它）
      const grew = (session.messages?.length ?? 0) > baselineMessageCount;
      const freshAnswer = grew ? extractLastAssistantText(session) : "";
      const answer = freshAnswer || uiNotifyText;
      debugLog("feishu.prompt.done", {
        key,
        answerLength: answer.length,
        grew,
        uiNotifyLength: uiNotifyText.length,
        deltaCount,
        deltaChars,
      });
      await onReply(answer || "No response.");
      // onReply（ReplyCard.completeWithAnswer）已切到 done；此处仅兜底
      await status?.finish("done");
    };
    // 两种模式都排队：interrupt 已经同步发起了中断，上一轮会很快收敛，所以「排队」不会真的等很久
    const next = this.previousTurn(key).then(runTurn).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      debugLog("feishu.prompt.error", { key, error: message });
      // 错误也写进同一张卡；onReply 若已是 completeWithAnswer 会 no-op（status 非 running）
      if (status && "ensureFinal" in status && typeof (status as any).ensureFinal === "function") {
        (status as any).ensureFinal(`出错了：${message}`);
        await status.finish("failed", message);
      } else {
        await status?.finish("failed", message);
        await onReply(`Pi error: ${message}`);
      }
    });
    this.queues.set(key, next);
    await next;
  }

  /** 当前全局投递策略是否为「立即打断」（读不到配置时按 queue 处理） */
  private isInterruptDelivery(): boolean {
    try {
      return loadConfig()?.messageDelivery === "interrupt";
    } catch {
      return false;
    }
  }

  /**
   * 掰掉当前正在跑的那一轮：先标 stopped（它的 catch 据此静默收尾）、结束它的卡片，
   * 再 abort —— 本轮会等队列上一轮收敛，所以这里不需要再 waitForIdle。
   * 全程不抛错（调用处用 void 发起）。
   */
  private async interruptActiveRun(key: string) {
    const active = this.activeRuns.get(key);
    if (!active) return;
    debugLog("feishu.prompt.interrupted_by_new_message", { key, runId: active.runId });
    active.stopped = true;
    try {
      await active.status?.stopImmediately("已被新消息打断");
    } catch {}
    try {
      await active.session.abort();
    } catch (error) {
      debugLog("feishu.prompt.interrupt_abort_error", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 供 /status 使用 */
  getStatus(key: string): ConversationStatus {
    const active = this.activeRuns.get(key);
    return {
      cwd: this.getWorkspace(key),
      hasActiveRun: Boolean(active),
      activeStopped: Boolean(active?.stopped),
    };
  }

  async getActualModel(key: string) {
    const model = await this.getSelectedModel(key);
    if (!model) return "默认模型";
    return `${model.provider}/${model.id}`;
  }

  /** 当前 Pi 会话的思考强度和该模型可用的档位。 */
  async getThinkingStatus(key: string): Promise<ThinkingStatus> {
    const session = await this.getSession(key);
    return this.getThinkingStatusForSession(session);
  }

  async getContextStatus(key: string): Promise<ContextUsage | null> {
    try {
      const session = await this.getSession(key);
      const anySession = session as any;
      const tokens = anySession.contextTokens ?? anySession.tokenCount ?? null;
      const contextWindow = anySession.contextWindow ?? anySession.model?.contextWindow ?? null;
      const percent = tokens != null && contextWindow ? (Number(tokens) / Number(contextWindow)) * 100 : null;
      return { tokens: tokens != null ? Number(tokens) : null, contextWindow: contextWindow != null ? Number(contextWindow) : null, percent };
    } catch {
      return null;
    }
  }

  async stopConversation(key: string, onReply: (text: string) => Promise<void>, runId?: string): Promise<StopConversationResult> {
    const active = this.activeRuns.get(key);
    if (!active) {
      const message = "当前没有进行中的处理。";
      await onReply(message);
      return { status: "not_running", message };
    }
    if (runId && active.runId && active.runId !== runId) {
      const message = "这张任务卡片已不是当前进行中的任务。";
      await onReply(message);
      debugLog("feishu.prompt.stop_stale", { key, runId, activeRunId: active.runId });
      return { status: "stale", message };
    }

    active.stopped = true;
    const body = active.status?.bodyText || "";
    await active.status?.stopImmediately("已停止");
    try {
      await active.session.abort();
      debugLog("feishu.prompt.abort", { key });
      const message = "已停止";
      await onReply(message);
      return { status: "stopped", message, body };
    } catch (error) {
      active.stopped = false;
      debugLog("feishu.prompt.abort_error", { key, error: error instanceof Error ? error.message : String(error) });
      const message = "停止失败，请重试。";
      await onReply(message);
      return { status: "failed", message };
    }
  }

  async newConversation(key: string, onReply: (text: string) => Promise<void>) {
    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      const cached = this.sessions.get(key);
      if (cached) {
        try { (await cached).dispose(); } catch {}
      }
      this.sessions.delete(key);
      this.sessionFileStats.delete(key);
      delete this.state.sessions[key];
      writeJson(STATE_PATH, this.state);
      await onReply("已创建新会话。旧会话历史已保留，下一条消息会从新上下文开始。");
    }).catch(async (error) => {
      await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  async listResumeSessions(key: string, scope: ResumeScope, page: number): Promise<ResumeSessionPage> {
    const sessions = await this.getResumeSessions(key, scope);
    const normalizedPage = Math.max(0, Math.floor(page));
    const total = sessions.length;
    const totalPages = Math.max(1, Math.ceil(total / RESUME_PAGE_SIZE));
    const clampedPage = Math.min(normalizedPage, totalPages - 1);
    const currentSessionPath = this.normalizeSessionPath(this.state.sessions[key]);
    const start = clampedPage * RESUME_PAGE_SIZE;
    const items = sessions.slice(start, start + RESUME_PAGE_SIZE).map((session) => {
      const sessionPath = this.normalizeSessionPath(session.path) || session.path;
      return {
        path: session.path,
        title: session.name?.trim() || summarizeFirstMessage(session.firstMessage),
        subtitle: session.name?.trim()
          ? summarizeFirstMessage(session.firstMessage)
          : `消息数：${session.messageCount}`,
        modifiedLabel: formatModifiedLabel(session.modified),
        workspaceLabel: scope === "all" ? formatWorkspaceLabel(session.cwd) : undefined,
        isCurrent: Boolean(currentSessionPath && sessionPath && currentSessionPath === sessionPath),
      };
    });

    return {
      key,
      workspacePath: this.getWorkspace(key),
      scope,
      page: clampedPage,
      total,
      totalPages,
      items,
    };
  }

  async resumeConversation(key: string, sessionPathInput: string, onReply: (text: string) => Promise<void>) {
    if (this.activeRuns.has(key)) {
      await onReply("当前还有进行中的处理，请先发送 /stop，再切换历史会话。");
      return;
    }

    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      const sessionPath = this.normalizeExistingSessionPath(sessionPathInput);
      const sessionInfo = await this.findSessionInfo(sessionPath);
      if (!sessionInfo) {
        await onReply("这条历史会话不存在，可能已经被删除。请重新打开 /resume 选择。");
        return;
      }

      const currentPath = this.normalizeSessionPath(this.state.sessions[key]);
      if (currentPath === sessionPath) {
        this.state.workspaces![key] = sessionInfo.cwd || this.getWorkspace(key);
        writeJson(STATE_PATH, this.state);
        this.recordSessionFileStat(key, sessionPath);
        await onReply(`你已经在这个历史会话里了。\n当前工作区：${this.state.workspaces![key]}`);
        return;
      }

      const cached = this.sessions.get(key);
      if (cached) {
        try { (await cached).dispose(); } catch {}
      }

      this.sessions.delete(key);
      this.sessionFileStats.delete(key);
      this.state.sessions[key] = sessionPath;
      this.state.workspaces![key] = sessionInfo.cwd || this.cwd;
      writeJson(STATE_PATH, this.state);
      this.recordSessionFileStat(key, sessionPath);
      await onReply([
        `已切换到历史会话：${sessionInfo.name?.trim() || summarizeFirstMessage(sessionInfo.firstMessage)}`,
        `工作区：${this.state.workspaces![key]}`,
        "下一条消息会继续接着这个会话往下聊。",
      ].join("\n"));
    }).catch(async (error) => {
      await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  async selectModel(key: string, provider: string, modelId: string, onReply: (text: string) => Promise<void>) {
    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      const modelRuntime = await this.getModelRuntime();
      const model = modelRuntime.getModel(provider, modelId);
      if (!model || !modelRuntime.hasConfiguredAuth(model)) {
        await onReply(`这个模型当前不可用：${provider}/${modelId}。请发送 /model 重新选择。`);
        return;
      }

      const existing = this.state.models?.[key];
      this.state.models![key] = { provider, id: modelId, thinkingLevel: existing?.thinkingLevel };
      writeJson(STATE_PATH, this.state);

      const cached = this.sessions.get(key);
      if (cached) {
        try { (await cached).dispose(); } catch {}
      }
      this.sessions.delete(key);
      this.sessionFileStats.delete(key);
      await onReply(`已切换到 ${provider}/${modelId}。当前飞书会话后续都会使用这个模型。`);
    }).catch(async (error) => {
      await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  async selectThinkingLevel(key: string, level: string, onReply: (text: string) => Promise<void>) {
    if (this.activeRuns.has(key)) {
      await onReply("当前正在生成回复，请等待完成后再调整思考强度。");
      return;
    }
    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      const session = await this.getSession(key);
      const status = this.getThinkingStatusForSession(session);
      if (!status.available) {
        await onReply("无法从 Pi 读取当前模型可用的 thinking levels，未做任何修改。请稍后重试。");
        return;
      }
      if (!status.availableLevels.includes(level)) {
        await onReply(`Pi 当前模型不支持 thinking level \`${level}\`。请重新发送 /thinking 选择。`);
        return;
      }

      const sessionApi = session as any;
      if (typeof sessionApi.setThinkingLevel !== "function") {
        await onReply("当前 Pi 版本不支持从飞书调整思考强度。请升级 Pi 后重试。");
        return;
      }
      sessionApi.setThinkingLevel(level);
      const existing = this.state.models?.[key];
      if (existing) {
        this.state.models![key] = { ...existing, thinkingLevel: level };
        writeJson(STATE_PATH, this.state);
      }
      const effective = this.getThinkingStatusForSession(session).currentLevel || level;
      await onReply(`Thinking level set to: ${effective}`);
    }).catch(async (error) => {
      await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  getWorkspace(key: string) {
    return this.state.workspaces?.[key] || this.cwd;
  }

  async switchWorkspace(key: string, workspaceInput: string | undefined, onReply: (text: string) => Promise<void>) {
    if (!workspaceInput) {
      const current = this.getWorkspace(key);
      await onReply([
        `当前工作区：${current}`,
        "用法：/workspace /绝对路径",
        "也支持：/workspace ~/your/project",
      ].join("\n"));
      return;
    }

    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      const workspace = resolveWorkspacePath(workspaceInput);
      const cached = this.sessions.get(key);
      if (cached) {
        try { (await cached).dispose(); } catch {}
      }
      this.sessions.delete(key);
      this.sessionFileStats.delete(key);
      delete this.state.sessions[key];
      this.state.workspaces![key] = workspace;
      writeJson(STATE_PATH, this.state);
      await onReply(`已切换到工作区：${workspace}\n下一条消息会在这个目录里创建新的 Pi 会话。`);
    }).catch(async (error) => {
      await onReply(error instanceof Error ? error.message : `Pi error: ${String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  async getAvailableModels(): Promise<RuntimeModel[]> {
    const modelRuntime = await this.getModelRuntime();
    const available = await modelRuntime.getAvailable();
    return [...available]
      .map(toRuntimeModel)
      .sort((a, b) => {
        const providerCmp = a.provider.localeCompare(b.provider);
        if (providerCmp !== 0) return providerCmp;
        return a.id.localeCompare(b.id);
      });
  }

  async getSelectedModel(key: string): Promise<RuntimeModel | undefined> {
    const native = await this.getSelectedNativeModel(key);
    return native ? toRuntimeModel(native) : undefined;
  }

  /** 内部使用的原生 Pi 模型（不跨出本适配器）。 */
  private async getSelectedNativeModel(key: string) {
    const modelRuntime = await this.getModelRuntime();
    const selected = this.state.models?.[key];
    if (selected) {
      const model = modelRuntime.getModel(selected.provider, selected.id);
      if (model && modelRuntime.hasConfiguredAuth(model)) return model;
    }
    const cached = this.sessions.get(key);
    if (cached) {
      return (await cached).model;
    }
    // Check settings default model before falling back to first available
    if (this.defaultProvider && this.defaultModelId) {
      const defaultModel = modelRuntime.getModel(this.defaultProvider, this.defaultModelId);
      if (defaultModel && modelRuntime.hasConfiguredAuth(defaultModel)) {
        return defaultModel;
      }
    }
    const available = await this.getAvailableModels();
    const first = available[0];
    return first ? modelRuntime.getModel(first.provider, first.id) : undefined;
  }

  private getModelRuntime() {
    this.modelRuntimePromise ||= createModelRuntimeAdapter();
    return this.modelRuntimePromise;
  }

  resetMemory() {
    for (const session of this.sessions.values()) {
      void session.then((s) => s.dispose()).catch(() => undefined);
    }
    this.sessions.clear();
    this.sessionFileStats.clear();
    this.queues.clear();
    this.state = { sessions: {}, models: {}, workspaces: {} };
  }

  private recordSessionFileStat(key: string, sessionFile?: string) {
    const filePath = sessionFile || this.state.sessions[key];
    if (!filePath) {
      this.sessionFileStats.delete(key);
      return;
    }
    try {
      if (existsSync(filePath)) {
        const stat = statSync(filePath);
        this.sessionFileStats.set(key, {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        });
      }
    } catch {}
  }

  private async ensureSessionFresh(key: string): Promise<AgentSession> {
    const cachedPromise = this.sessions.get(key);
    if (!cachedPromise) {
      return this.getSession(key);
    }
    const sessionFile = this.state.sessions[key];
    const recorded = this.sessionFileStats.get(key);
    if (sessionFile && existsSync(sessionFile)) {
      try {
        const currentStat = statSync(sessionFile);
        const isModified = recorded
          ? currentStat.mtimeMs > recorded.mtimeMs || currentStat.size !== recorded.size
          : false;
        if (isModified) {
          debugLog("feishu.pi.session_hot_reload", {
            key,
            sessionFile,
            recordedMtime: recorded?.mtimeMs,
            currentMtime: currentStat.mtimeMs,
            recordedSize: recorded?.size,
            currentSize: currentStat.size,
          });
          try {
            const oldSession = await cachedPromise;
            oldSession.dispose();
          } catch {}
          this.sessions.delete(key);
          const refreshed = this.createSession(key);
          this.sessions.set(key, refreshed);
          return refreshed;
        }
        if (!recorded) {
          this.sessionFileStats.set(key, {
            mtimeMs: currentStat.mtimeMs,
            size: currentStat.size,
          });
        }
      } catch {}
    }
    return cachedPromise;
  }

  private getSession(key: string): Promise<AgentSession> {
    const cached = this.sessions.get(key);
    if (cached) return cached;
    const created = this.createSession(key);
    this.sessions.set(key, created);
    return created;
  }

  private getThinkingStatusForSession(session: AgentSession): ThinkingStatus {
    const sessionApi = session as any;
    const currentLevel = typeof sessionApi.thinkingLevel === "string" && sessionApi.thinkingLevel.trim()
      ? sessionApi.thinkingLevel
      : undefined;
    if (typeof sessionApi.getAvailableThinkingLevels !== "function") {
      return { currentLevel, availableLevels: [], available: false };
    }
    try {
      return {
        currentLevel,
        availableLevels: normalizeThinkingLevels(sessionApi.getAvailableThinkingLevels()),
        available: true,
      };
    } catch {
      return { currentLevel, availableLevels: [], available: false };
    }
  }

  private previousTurn(key: string) {
    // Keep a conversation serial for as long as Pi needs. A bridge-side queue
    // timeout can start a second turn while the first is still streaming.
    return this.queues.get(key) || Promise.resolve();
  }

  private notifyMs() {
    const sec = this.timeouts.promptNotifySec;
    return typeof sec === "number" && Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;
  }

  private hardTimeoutMs() {
    const sec = this.timeouts.promptTimeoutSec;
    return typeof sec === "number" && Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;
  }

  /** 轮次开始：登记活跃 key，并清空上一轮残留的 notify 缓冲 */
  private enterFeishuTurn(key: string) {
    this.activeTurnKeys.push(key);
    this.uiNotifyBuffers.set(key, []);
  }

  /** 轮次结束：注销 key 并丢弃未使用的 notify 缓冲 */
  private exitFeishuTurn(key: string) {
    const index = this.activeTurnKeys.lastIndexOf(key);
    if (index >= 0) this.activeTurnKeys.splice(index, 1);
    this.uiNotifyBuffers.delete(key);
  }

  /**
   * 接收 Pi 侧扩展 emit 的 UI 通知，路由到「最近一次飞书发起的轮次」。
   * 没有活跃轮次时（例如命令来自 Pi TUI）直接丢弃，避免误发到飞书会话。
   */
  pushUiNotify(payload: FeishuUiNotifyPayload | string) {
    const key = this.activeTurnKeys[this.activeTurnKeys.length - 1];
    if (!key) return;
    const text = (typeof payload === "string" ? payload : String(payload?.text ?? "")).trim();
    if (!text) return;
    const buffer = this.uiNotifyBuffers.get(key) || [];
    // 同一条文案在一次轮次里可能被重复 notify，去重避免刷屏
    if (buffer.includes(text)) return;
    buffer.push(text);
    this.uiNotifyBuffers.set(key, buffer);
    debugLog("feishu.ui.notify_received", { key, length: text.length });
  }

  /** 取走并清空某轮次累积的扩展 notify 文本 */
  private drainUiNotify(key: string): string {
    const buffer = this.uiNotifyBuffers.get(key);
    if (!buffer?.length) return "";
    this.uiNotifyBuffers.set(key, []);
    return buffer.join("\n\n");
  }

  /**
   * 发一张选择题卡片给「发起这次提问的会话」，并等用户点击。
   * 全部答完 → 返回答案；超时 → 返回已答部分（timedOut=true），不把整轮卡死。
   *
   * key 必须由调用方（工具闭包）显式传入：activeTurnKeys 是所有会话共用的栈顶，
   * 私聊/群聊并发时会取到别的会话，导致卡片发错聊天（跨会话串台）。
   */
  private async askUser(sessionKey: string, questions: AskQuestion[]): Promise<AskOutcome> {
    const key = sessionKey;
    if (!key) throw new Error("当前没有活跃的飞书会话");
    if (!this.askSender) throw new Error("飞书连接未就绪");

    const sender = this.askSender;
    const outcome = await new Promise<AskOutcome>((resolve) => {
      const record = registerAsk(key, questions, resolve, {
        // 超时后必须把卡片原地刷成「已超时」：否则卡片还带着按钮，
        // 用户再点只会被判为「迟到的点击」，而他看到的是一张「还在等你选」的卡。
        onTimeout: (settled) => {
          const updater = this.askCardUpdater;
          const cardMessageId = settled.cardMessageId;
          if (!updater || !cardMessageId) return;
          void updater(cardMessageId, buildAskCard(settled.askId, settled.questions, settled.answers, "timeout"))
            .catch((error) => {
              debugLog("feishu.ask.timeout_card_failed", {
                askId: settled.askId,
                key,
                error: error instanceof Error ? error.message : String(error),
              });
            });
        },
      });
      void sender(key, buildAskCard(record.askId, questions, record.answers))
        .then((messageId) => {
          // 回填卡片消息 ID，超时刷卡片时要用
          if (messageId) setAskCardMessage(record.askId, messageId);
        })
        .catch((error) => {
          debugLog("feishu.ask.send_failed", {
            askId: record.askId,
            key,
            error: error instanceof Error ? error.message : String(error),
          });
          cancelAsk(record.askId);
        });
    });
    debugLog("feishu.ask.settled", {
      key,
      timedOut: outcome.timedOut,
      answered: outcome.answers.filter((answer) => answer.chosen).length,
      total: outcome.answers.length,
    });
    return outcome;
  }

  /**
   * feishu_ask：把选择题渲染成飞书卡片按钮，用户点完再把结果交回模型。
   * 作为 customTools 注入会话（桥接扩展不在会话里加载，所以不能靠 registerTool）。
   * 工具按会话创建，闭包持有该会话的 key，保证卡片只发回提问所在的那个会话。
   */
  private buildAskTool(sessionKey: string) {
    return {
      name: "feishu_ask",
      label: "Feishu Ask",
      description:
        "Ask the user to pick from options in the Feishu chat. Renders an interactive card with buttons and returns the user's choices. "
        + "Use this instead of asking option questions as plain text (e.g. 'reply 1A 2A 3A') — typing letters back is a terrible experience.",
      promptSnippet: "Ask the user multiple-choice questions as clickable Feishu card buttons.",
      promptGuidelines: [
        "Replying through Feishu and the user must choose between options: call feishu_ask, do not list options as plain text.",
        "Keep option labels short (<= 10 chars); put the trade-off explanation into description.",
        "At most 4 questions per call; each question gets 2-4 options.",
      ],
      parameters: Type.Object({
        questions: Type.Array(
          Type.Object({
            header: Type.String({ description: "Short label, <= 16 chars, e.g. 货币范围" }),
            question: Type.String({ description: "Full question text" }),
            options: Type.Array(
              Type.Object({
                label: Type.String({ description: "Short label shown on the button (<= 10 chars)" }),
                description: Type.Optional(Type.String({ description: "One-line explanation of this option" })),
              }),
              { minItems: 2, maxItems: 4 },
            ),
          }),
          { minItems: 1, maxItems: 4 },
        ),
      }),
      execute: async (_toolCallId: string, params: unknown) => {
        const questions = normalizeAskQuestions((params as { questions?: unknown })?.questions);
        if (!questions.length) {
          return askToolResult("Error: questions 需要 1-4 个问题，每个 2-4 个选项。");
        }
        try {
          return askToolResult(formatAskOutcome(await this.askUser(sessionKey, questions)));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return askToolResult(`Error: ${message}，请改用纯文本向用户提问。`);
        }
      },
    };
  }

  /**
   * 进化审批工具：把「改文件」这件事变成一道必须过的审批。
   *
   * 与 feishu_ask 一样是**会话级注入**的：需要当前会话的 key 才能拿到发起人 open_id。
   * 本地「派」（无飞书桥接）不会注册本工具，因此 /learn 应用 在派里会退化提示。
   */
  private buildLearnApprovalTool(sessionKey: string) {
    return {
      name: "feishu_learn_approval",
      label: "Feishu Learn Approval",
      description:
        "Submit a Feishu approval request for an evolution (/learn) and wait for the result. "
        + "Returns APPROVED / REJECTED / CANCELED / TIMEOUT. ONLY when it returns APPROVED may you modify any file.",
      promptSnippet: "Ask the approver to approve an evolution (/learn) via a real Feishu approval form.",
      promptGuidelines: [
        "Before modifying ANY file for /learn 应用, call feishu_learn_approval and wait for APPROVED.",
        "Put the authorized candidate points verbatim into body so the approver knows exactly what will be changed.",
        "If the result is not APPROVED, do NOT modify anything and report the status to the user.",
      ],
      parameters: Type.Object({
        body: Type.String({
          description:
            "Approval content: the candidate points to be applied (id, target file, what will change). Be specific.",
        }),
      }),
      execute: async (_toolCallId: string, params: unknown) => {
        const body = String((params as { body?: unknown })?.body ?? "").trim();
        if (!body) return askToolResult("Error: body 不能为空，请填要落地的候选点内容。");
        if (!this.learnApprovalRequester) {
          return askToolResult(
            "Error: 当前环境没有接入飞书审批通道，无法为进化取授权。请在飞书会话里执行 /learn 应用 <编号>。",
          );
        }
        try {
          return askToolResult(formatApprovalOutcome(await this.learnApprovalRequester(sessionKey, body)));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return askToolResult(`Error: 发起/等待进化审批失败：${message}。一个字都不要改，把原因告诉用户。`);
        }
      },
    };
  }

  /**
   * 扩展命令（/req /kb /test 等）走 session.prompt 时只做「派发」：
   * prompt() 立即返回，真正的模型轮次由命令处理器内部的 pi.sendUserMessage 触发。
   * 不等这一轮跑完就拿答案，卡片只会显示 "No response."。
   *
   * 注：pi 会吞掉命令处理器抛的异常（只丢给 extensionRunner.emitError），
   * 所以这里不能靠 prompt() reject 判断失败。
   */
  private async settleForwardedCommand(
    session: AgentSession,
    userText: string,
    key: string,
    baselineMessageCount: number,
  ) {
    if (!userText.trimStart().startsWith("/")) return;

    // 等轮次「启动」：消息条数增长或进入 streaming 都算
    const startedAt = Date.now();
    while (Date.now() - startedAt < COMMAND_STARTUP_WINDOW_MS) {
      if (!session.isIdle) break;
      if ((session.messages?.length ?? 0) > baselineMessageCount) break;
      await sleep(50);
    }
    if (session.isIdle) return;

    const hardMs = this.hardTimeoutMs();
    debugLog("feishu.command.settle_wait", {
      key,
      hardMs,
      startupMs: Date.now() - startedAt,
    });
    const waitIdle = session.waitForIdle().catch(() => undefined);
    if (hardMs <= 0) {
      await waitIdle;
      return;
    }
    await Promise.race([waitIdle, sleep(hardMs)]);
  }

  private async runPromptWithTimeouts(
    session: AgentSession,
    userText: string,
    images: Array<{ type: "image"; data: string; mimeType: string }>,
    key: string,
    onReply: (text: string) => Promise<void>,
    status?: ReplyCardSink,
  ) {
    const notifyMs = this.notifyMs();
    const hardMs = this.hardTimeoutMs();
    const hardSec = Math.round(hardMs / 1000);
    // 默认透传（expandPromptTemplates: false）：斜杠文本原样进模型。
    // 例外：DISPATCHED_SLASH_COMMANDS（如 /learn、/deploy-test）明确是「执行流程」，交回 Pi 派发。
    const dispatch = shouldDispatchSlashCommand(userText);
    debugLog("feishu.prompt.dispatch_decision", { key, dispatch });
    await waitForPrompt(session.prompt(userText, {
      ...(images.length ? { images } : {}),
      expandPromptTemplates: dispatch,
    }), {
      notifyMs,
      hardMs,
      hardTimeoutMessage: `Pi 模型处理超时（超过 ${hardSec} 秒）仍未完成，已中止处理。可调大 config.json 中的 promptTimeoutSec。`,
      onStillRunning: () => {
        debugLog("feishu.prompt.notify_still_running", { key, elapsedMs: notifyMs });
        // A ReplyCard stays visibly "replying"; sending this as a final answer
        // would prematurely close the same card, so only non-card callers get
        // the legacy notice.
        if (status) return;
        void onReply("⏳ 仍在处理中，没有失败。请耐心等待，也可以点击「停止」中止。")
          .catch(() => undefined);
      },
      onHardTimeout: async () => {
        debugLog("feishu.prompt.hard_timeout", { key, elapsedMs: hardMs });
        try {
          await session.abort();
        } catch {}
      },
    });
  }

  private async createSession(key: string): Promise<AgentSession> {
    const workspaceCwd = this.getWorkspace(key);
    ensureWorkspaceExists(workspaceCwd);
    const existingFile = this.state.sessions[key];
    const selected = this.state.models?.[key];
    const modelRuntime = await this.getModelRuntime();
    const model = selected ? modelRuntime.getModel(selected.provider, selected.id) : undefined;
    const sessionManager = existingFile && existsSync(existingFile)
      ? SessionManager.open(existingFile, undefined, workspaceCwd)
      : SessionManager.create(workspaceCwd);

    const loader = new DefaultResourceLoader({
      cwd: workspaceCwd,
      agentDir: getAgentDir(),
      systemPromptOverride: (base) => {
        const extra = "You are replying through Feishu/Lark. Keep answers concise and readable in chat. Do not use markdown tables.";
        return base?.trim() ? `${base}\n\n${extra}` : extra;
      },
    });

    const previousChildEnv = process.env[CHILD_SESSION_ENV];
    process.env[CHILD_SESSION_ENV] = "1";
    try {
      await loader.reload();
    } finally {
      if (previousChildEnv === undefined) delete process.env[CHILD_SESSION_ENV];
      else process.env[CHILD_SESSION_ENV] = previousChildEnv;
    }

    const { session } = await createAgentSession({
      cwd: workspaceCwd,
      agentDir: getAgentDir(),
      ...modelRuntime.sessionOptions,
      model,
      sessionManager,
      resourceLoader: loader,
      // 选择题卡片工具只在飞书会话里有意义，故按会话注入而不是扩展注册
      customTools: [this.buildAskTool(key), this.buildLearnApprovalTool(key)],
    } as any);

    await session.bindExtensions({});
    this.bridge?.attachSession(key, session.sessionId);
    // 会话级长期订阅：保证 text_delta 在 prompt 期间一定能收到
    session.subscribe((event: any) => {
      const run = this.activeRuns.get(key);
      run?.status?.updateFromEvent(event);
      const delta = extractAssistantTextDelta(event);
      if (delta && run && !run.stopped) {
        // 优先 onDelta（与 prompt 绑定）；否则直接 append 到 status 卡
        if (run.onDelta) run.onDelta(delta);
        else if (run.status && typeof (run.status as any).append === "function") {
          (run.status as any).append(delta);
        }
      }
      if (event.type === "message_end") {
        handlePiMessageEnd(this.bridge, session.sessionId, key, event.message);
      }
    });

    const desiredThinkingLevel = this.state.models?.[key]?.thinkingLevel;
    if (desiredThinkingLevel && typeof (session as any).setThinkingLevel === "function") {
      try {
        (session as any).setThinkingLevel(desiredThinkingLevel);
      } catch {}
    }

    if (session.sessionFile && this.state.sessions[key] !== session.sessionFile) {
      this.state.sessions[key] = session.sessionFile;
      writeJson(STATE_PATH, this.state);
    }
    this.recordSessionFileStat(key, session.sessionFile);
    return session;
  }

  private async getResumeSessions(key: string, scope: ResumeScope) {
    const base = scope === "all"
      ? await SessionManager.listAll()
      : await SessionManager.list(this.getWorkspace(key));
    return [...base].sort((a, b) => toTimeMs(b.modified) - toTimeMs(a.modified));
  }

  private async findSessionInfo(sessionPath: string): Promise<SessionInfo | undefined> {
    const currentWorkspace = this.getWorkspaceFromSessionFile(sessionPath);
    const localSessions = currentWorkspace ? await SessionManager.list(currentWorkspace) : [];
    const normalizedTarget = this.normalizeSessionPath(sessionPath);
    const fromLocal = localSessions.find((item) => this.normalizeSessionPath(item.path) === normalizedTarget);
    if (fromLocal) return fromLocal;
    const allSessions = await SessionManager.listAll();
    return allSessions.find((item) => this.normalizeSessionPath(item.path) === normalizedTarget);
  }

  private getWorkspaceFromSessionFile(sessionPath: string) {
    try {
      return SessionManager.open(sessionPath).getCwd();
    } catch {
      return undefined;
    }
  }

  private normalizeExistingSessionPath(path: string) {
    if (!path || !existsSync(path)) {
      throw new Error("历史会话不存在，可能已经被删除。");
    }
    return realpathSync(path);
  }

  private normalizeSessionPath(path: string | undefined) {
    if (!path) return undefined;
    try {
      return existsSync(path) ? realpathSync(path) : path;
    } catch {
      return path;
    }
  }
}

/**
 * Pi changed its model-session API between releases. Keep the bridge usable
 * with both the AuthStorage/ModelRegistry API and the newer ModelRuntime API.
 */
async function createModelRuntimeAdapter(): Promise<ModelRuntimeAdapter> {
  const sdk = PiSdk as any;
  if (typeof sdk.ModelRuntime?.create === "function") {
    const runtime = await sdk.ModelRuntime.create();
    return {
      getModel: (provider, id) => runtime.getModel(provider, id),
      hasConfiguredAuth: (model) => runtime.hasConfiguredAuth(model.provider),
      getAvailable: async () => [...await runtime.getAvailable()],
      sessionOptions: { modelRuntime: runtime },
    };
  }

  if (typeof sdk.AuthStorage?.create === "function" && typeof sdk.ModelRegistry?.create === "function") {
    const authStorage = sdk.AuthStorage.create();
    const modelRegistry = sdk.ModelRegistry.create(authStorage);
    return {
      getModel: (provider, id) => modelRegistry.find(provider, id),
      hasConfiguredAuth: (model) => modelRegistry.hasConfiguredAuth(model),
      getAvailable: async () => [...await modelRegistry.getAvailable()],
      sessionOptions: { authStorage, modelRegistry },
    };
  }

  throw new Error("当前 Pi 版本不支持创建飞书会话所需的模型运行时。");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}


/** 从 Pi AgentSession 事件中提取 assistant 最终可见文本增量 */
function extractAssistantTextDelta(event: any): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  // 标准：message_update + assistantMessageEvent.text_delta
  if (event.type === "message_update") {
    const ame = event.assistantMessageEvent;
    if (ame?.type === "text_delta" && typeof ame.delta === "string" && ame.delta) {
      return ame.delta;
    }
    // 兼容：delta 挂在 event 上
    if (typeof event.delta === "string" && event.delta) return event.delta;
  }
  // 兼容：顶层 text_delta
  if (event.type === "text_delta" && typeof event.delta === "string" && event.delta) {
    return event.delta;
  }
  return undefined;
}

function extractLastAssistantText(session: AgentSession): string {
  const messages = [...(session.messages || [])].reverse();
  for (const msg of messages as any[]) {
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      return content
        .map((p) => p?.type === "text" ? p.text : "")
        .join("")
        .trim();
    }
  }
  return "";
}

/** 把 Pi 原生模型对象转换成平台无关的 RuntimeModel（禁止原生对象泄漏到飞书层）。 */
function toRuntimeModel(model: any): RuntimeModel {
  const input = Array.isArray(model?.input) ? model.input : [];
  return {
    provider: String(model?.provider ?? ""),
    id: String(model?.id ?? ""),
    name: typeof model?.name === "string" ? model.name : undefined,
    supportsImage: input.includes("image"),
  };
}

/**
 * 把 Pi 的 message_end 事件解析成平台无关的桥接事件（Pi 内部任务回传）。
 * 原 ConversationManager.handleMessageEnd 的等价逻辑。
 */
export function handlePiMessageEnd(
  bridge: FeishuBridgeRuntime | undefined,
  sessionId: string | undefined,
  sessionKey: string | undefined,
  message: any,
) {
  if (!bridge || !sessionId || !message) return;

  if (message.role === "toolResult" && message.toolName === "schedule_prompt") {
    const details = message.details || {};
    if (details.action !== "add") return;
    const rawJobs = Array.isArray(details.jobs) ? details.jobs : [];
    const jobs: Array<{ id: string; name?: string }> = [];
    for (const job of rawJobs) {
      if (!job?.id) continue;
      jobs.push({
        id: String(job.id),
        name: typeof job.name === "string" ? job.name : undefined,
      });
    }
    if (jobs.length) {
      bridge.handleJobEvent({ kind: "created", sessionId, sessionKey, jobs });
    }
    return;
  }

  if (message.role === "custom" && message.customType === "scheduled_prompt") {
    const details = message.details || {};
    const jobId = typeof details.jobId === "string" ? details.jobId : "";
    if (!jobId) return;

    if (details.mode === "subagent_done" && typeof details.output === "string") {
      bridge.handleJobEvent({
        kind: "done",
        sessionId,
        jobId,
        text: details.output,
        dedupeKey: `subagent_done:${jobId}:${message.id || details.output}`,
      });
      return;
    }

    if (details.mode === "subagent_error" && typeof details.error === "string") {
      bridge.handleJobEvent({
        kind: "error",
        sessionId,
        jobId,
        error: details.error,
        dedupeKey: `subagent_error:${jobId}:${message.id || details.error}`,
      });
      return;
    }

    bridge.handleJobEvent({ kind: "marker", sessionId, jobId });
    return;
  }

  if (message.role === "assistant") {
    const text = extractMessageText(message);
    bridge.handleJobEvent({
      kind: "output",
      sessionId,
      text,
      messageId: message.id,
      timestamp: message.timestamp,
    });
  }
}

function extractMessageText(message: any) {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => part?.type === "text" ? part.text : "")
    .join("")
    .trim();
}

function summarizeFirstMessage(text: string) {
  const normalized = (text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "未命名会话";
  return normalized.length > 36 ? `${normalized.slice(0, 35)}...` : normalized;
}

function formatModifiedLabel(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function formatWorkspaceLabel(cwd: string) {
  if (!cwd) return "(unknown)";
  return `${basename(cwd)} · ${cwd}`;
}

function toTimeMs(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

/** 等待指定毫秒（用于扩展命令派发后的空闲轮询） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 整理 feishu_ask 的入参：丢空项、label 去重、限幅到 1-4 问题 × 2-4 选项 */
function normalizeAskQuestions(input: unknown): AskQuestion[] {
  if (!Array.isArray(input)) return [];
  const questions: AskQuestion[] = [];
  for (const raw of input.slice(0, 4)) {
    const item = raw as { header?: unknown; question?: unknown; options?: unknown };
    const question = String(item?.question ?? "").trim();
    if (!question) continue;
    const seen = new Set<string>();
    const options: { label: string; description?: string }[] = [];
    for (const rawOption of Array.isArray(item?.options) ? item.options.slice(0, 4) : []) {
      const option = rawOption as { label?: unknown; description?: unknown };
      const label = String(option?.label ?? "").trim();
      if (!label || seen.has(label)) continue;
      seen.add(label);
      const description = String(option?.description ?? "").trim();
      options.push(description ? { label, description } : { label });
    }
    if (options.length < 2) continue;
    const header = String(item?.header ?? "").trim();
    questions.push({ header: header || question.slice(0, 16), question, options });
  }
  return questions;
}

/** 把用户选择整理成交给模型的文本 */
function formatAskOutcome(outcome: AskOutcome): string {
  const lines = outcome.answers.map(
    (answer, index) => `${index + 1}. [${answer.header}] ${answer.question} → ${answer.chosen ?? "（未选择）"}`,
  );
  const body = `用户的选择：\n${lines.join("\n")}`;
  return outcome.timedOut ? `${body}\n\n（等待点击超时，未作答项按「未选择」处理。）` : body;
}

function askToolResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}
