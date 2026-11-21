import { getRuntimeSource, readJson, writeJson } from "./config.ts";
import type { FeishuBridgeState, FeishuJobRoute, FeishuMessage, FeishuRoute } from "./types.ts";

const DEFAULT_STATE: FeishuBridgeState = { version: 1, routes: {}, jobs: {}, sent: {} };

function bridgePath() {
  return getRuntimeSource().bridgePath;
}

export class FeishuBridgeStore {
  bindConversation(sessionKey: string, msg: FeishuMessage, sessionId?: string) {
    const state = this.read();
    const previous = state.routes[sessionKey];
    const route: FeishuRoute = {
      sessionKey,
      sessionId: sessionId || previous?.sessionId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      threadMessageId: routeThreadMessageId(msg, previous),
      lastMessageId: msg.messageId,
      senderOpenId: msg.senderOpenId || previous?.senderOpenId,
      updatedAt: Date.now(),
    };
    state.routes[sessionKey] = route;
    this.write(state);
    return route;
  }

  attachSession(sessionKey: string, sessionId: string) {
    const state = this.read();
    const route = state.routes[sessionKey];
    if (!route || route.sessionId === sessionId) return;
    state.routes[sessionKey] = { ...route, sessionId, updatedAt: Date.now() };
    this.write(state);
  }

  getRoute(sessionKey: string): FeishuRoute | undefined {    return this.read().routes[sessionKey];
  }

  bindJob(sessionKey: string, jobId: string, jobName?: string, sessionId?: string): FeishuJobRoute | undefined {
    const state = this.read();
    const route = state.routes[sessionKey];
    if (!route) return undefined;
    const jobRoute: FeishuJobRoute = {
      ...route,
      sessionId: sessionId || route.sessionId,
      jobId,
      jobName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    state.jobs[jobId] = jobRoute;
    this.write(state);
    return jobRoute;
  }

  getJob(jobId: string): FeishuJobRoute | undefined {
    return this.read().jobs[jobId];
  }

  /**
   * 给定时任务的会话 key 绑一条路由。
   * 模型在这些会话里调 feishu_ask 时，提问卡要能发回任务的通知会话，
   * 没有路由会直接抛「找不到该会话的路由」。
   */
  bindScheduledRoute(
    sessionKey: string,
    target: { chatId: string; chatType: "p2p" | "group"; threadMessageId?: string },
  ): FeishuRoute {
    const state = this.read();
    const route: FeishuRoute = {
      sessionKey,
      chatId: target.chatId,
      chatType: target.chatType,
      threadMessageId: target.threadMessageId,
      lastMessageId: target.threadMessageId || "",
      updatedAt: Date.now(),
    };
    state.routes[sessionKey] = route;
    this.write(state);
    return route;
  }

  /** 任务删了就把它的临时路由一起清掉，避免桥接状态文件一直膨胀 */
  unbindRoute(sessionKey: string) {
    const state = this.read();
    if (!state.routes[sessionKey]) return;
    delete state.routes[sessionKey];
    this.write(state);
  }

  markSent(deliveryKey: string) {
    const state = this.read();
    state.sent[deliveryKey] = Date.now();
    this.write(state);
  }

  hasSent(deliveryKey: string) {
    return Boolean(this.read().sent[deliveryKey]);
  }

  private read(): FeishuBridgeState {
    const raw = readJson<FeishuBridgeState>(bridgePath(), DEFAULT_STATE);
    return {
      version: 1,
      routes: { ...(raw.routes || {}) },
      jobs: { ...(raw.jobs || {}) },
      sent: { ...(raw.sent || {}) },
    };
  }

  private write(state: FeishuBridgeState) {
    writeJson(bridgePath(), state);
  }
}

function routeThreadMessageId(msg: FeishuMessage, previous?: FeishuRoute) {
  if (msg.rootId || msg.parentId) return msg.rootId || msg.parentId;
  if (previous?.threadMessageId) return previous.threadMessageId;
  if (msg.threadId || msg.chatMode === "topic") return msg.messageId;
  return undefined;
}
