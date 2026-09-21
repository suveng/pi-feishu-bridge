import { extractTextFromInteractiveCard } from "./interactive-card.ts";
import type { FeishuAttachment, FeishuMessage, ParsedMessageInput } from "./types.ts";

export type BotCommand =
  | { name: "new" }
  | { name: "resume" }
  | { name: "model" }
  | { name: "thinking" }
  | { name: "stop" }
  | { name: "workspace"; path?: string }
  | { name: "status" }
  | { name: "commands" }
  | { name: "delivery" }
  | { name: "config"; key?: string; value?: string; clearTarget?: string };

type PostBody = {
  title?: string;
  content?: unknown[];
};

export function normalizeForDedupe(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 归一化到「只留内容」的形态：去空白、去中英文标点、统一小写。
 * 近重复判断用它，避免「只改了个错别字 / 少打一个逗号」被当成两条不同消息。
 */
export function normalizeForSimilarity(text: string) {
  return text
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[\u3000-\u303f\uff00-\uffef!-/:-@[-`{-~]/g, "");
}

/** 相似度超过这个值就算「同一句话」 */
export const NEAR_DUPLICATE_THRESHOLD = 0.9;

/**
 * 文本相似度（1 = 完全相同，0 = 毫无关系）：按编辑距离归一化。
 * 实测：改一个错别字的重复请求 0.952（拦下）；补一句追问「…了吗」0.8（放行）。
 */
export function textSimilarity(a: string, b: string): number {
  const x = normalizeForSimilarity(a);
  const y = normalizeForSimilarity(b);
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  if (x === y) return 1;
  // 超长文本（粘贴日志等）不做逐字编辑距离：代价高且它们本来就不像重复请求
  const CAP = 2000;
  const left = x.slice(0, CAP);
  const right = y.slice(0, CAP);
  return 1 - levenshteinDistance(left, right) / Math.max(left.length, right.length);
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/** 强制重跑的标记前缀：加了就直接开新一轮，不再被近重复拦住 */
export const RERUN_MARKERS = ["重发", "/again", "/重发"];

/**
 * 去掉「重发 / /again」前缀，返回真正要送给模型的正文。
 * 没有前缀时原样返回（调用方据此判断用户是否显式要求重跑）。
 */
export function stripRerunMarker(text: string): string {
  const trimmed = text.trimStart();
  const lower = trimmed.toLowerCase();
  for (const marker of RERUN_MARKERS) {
    if (!lower.startsWith(marker.toLowerCase())) continue;
    return trimmed.slice(marker.length).replace(/^[\s:：,，、-]+/, "");
  }
  return text;
}

export function pruneRecentMap(map: Map<string, number>, now: number, ttlMs: number) {
  for (const [key, timestamp] of map) {
    if (now - timestamp > ttlMs) map.delete(key);
  }
}

export function conversationKey(msg: FeishuMessage) {
  if (msg.chatType === "p2p") return `p2p:${msg.senderOpenId}`;
  const threadId = msg.threadId || msg.rootId || msg.parentId;
  if (threadId) return `group:${msg.chatId}:thread:${threadId}`;
  if (msg.chatMode === "topic") return `group:${msg.chatId}:thread:${msg.messageId}`;
  return `group:${msg.chatId}`;
}

export function conversationLabel(_msg: FeishuMessage) {
  // 不再给消息加渠道标签：已验证这类前缀会诱发模型把工具调用写成 DSML 文本草稿，
  // 导致整轮没有可发送的回答。消息文本保持与网页直输一致。
  return "";
}

export function parseMessageInput(
  msg: FeishuMessage,
  botOpenId?: string,
  options?: { parseInteractiveCards?: boolean },
): ParsedMessageInput {
  const attachments: FeishuAttachment[] = [];
  const parseInteractive = options?.parseInteractiveCards !== false;
  try {
    const json = JSON.parse(msg.content || "{}");
    if (msg.msgType === "text") {
      let text = String(json.text || "");
      if (botOpenId) text = text.replace(new RegExp(`@?${botOpenId}`, "g"), "");
      // 去掉飞书 @ 人的占位符（如 @_user_1）：对模型是无意义噪音
      text = text.replace(/@_user_\d+/g, "");
      return { text: text.trim(), attachments, source: "text" };
    }
    if (msg.msgType === "post") {
      const post = json.post || json;
      const locale = resolvePostBody(post);
      const parts: string[] = [];
      if (typeof locale?.title === "string" && locale.title.trim()) {
        parts.push(locale.title.trim());
      }
      for (const para of locale?.content || []) {
        const paragraphText = extractPostText(para, attachments).trim();
        if (paragraphText) parts.push(paragraphText);
      }
      collectAttachments(json, attachments);
      return { text: parts.join("\n").trim(), attachments, source: "post" };
    }
    if (msg.msgType === "interactive" && parseInteractive) {
      const extracted = extractTextFromInteractiveCard(msg.content || "{}");
      return { text: extracted.text, attachments: extracted.attachments, source: "interactive" };
    }
    if (msg.msgType === "image" && typeof json.image_key === "string" && json.image_key) {
      attachments.push({ kind: "image", fileKey: json.image_key });
      collectAttachments(json, attachments);
      return { text: "", attachments, source: "image" };
    }
    if (msg.msgType === "file" && typeof json.file_key === "string" && json.file_key) {
      attachments.push({
        kind: "file",
        fileKey: json.file_key,
        fileName: typeof json.file_name === "string" ? json.file_name : undefined,
      });
      collectAttachments(json, attachments);
      return { text: "", attachments, source: "file" };
    }
    collectAttachments(json, attachments);
    if (attachments.length) return { text: "", attachments, source: msg.msgType };
  } catch {}
  // 未知类型：不要静默丢弃，至少给 agent 一个占位
  if (msg.msgType === "text") return { text: msg.content, attachments, source: "text-raw" };
  if (msg.msgType === "interactive") {
    return {
      text: `[interactive]\n${(msg.content || "").slice(0, 1500)}`,
      attachments,
      source: "interactive-fallback",
    };
  }
  return { text: `[${msg.msgType}]`, attachments, source: "unknown" };
}

export function parseBotCommand(text: string): BotCommand | undefined {
  const trimmed = text.trim();
  const normalized = trimmed.replace(/\s+/g, " ");
  if (normalized === "/new") return { name: "new" };
  if (normalized === "/resume") return { name: "resume" };
  if (normalized === "/model") return { name: "model" };
  if (normalized === "/thinking") return { name: "thinking" };
  if (normalized === "/stop") return { name: "stop" };
  if (normalized === "/status") return { name: "status" };
  if (normalized === "/commands") return { name: "commands" };
  if (normalized === "/delivery") return { name: "delivery" };
  const workspaceMatch = trimmed.match(/^\/workspace(?:\s+(.+))?$/s);
  if (workspaceMatch) {
    return { name: "workspace", path: workspaceMatch[1]?.trim() };
  }
  const configMatch = trimmed.match(/^\/config(?:\s+(.+))?$/s);
  if (configMatch) {
    const rest = (configMatch[1] || "").trim();
    if (!rest) return { name: "config" };
    const parts = rest.split(/\s+/);
    if (parts[0] === "clear") {
      return { name: "config", clearTarget: parts[1] || "all" };
    }
    const key = parts[0];
    const value = rest.slice(key.length).trim();
    return { name: "config", key, value: value || undefined };
  }
  return undefined;
}

export function getCommandList(): string {
  return [
    "【桥接命令】由桥接直接处理",
    "/new — 新建会话",
    "/resume — 恢复历史会话（卡片选择）",
    "/model — 切换模型",
    "/thinking — 调整当前会话的思考强度",
    "/workspace [path] — 切换工作区",
    "/status — 查看当前模型、思考强度、目录和状态",
    "/stop — 停止当前生成",
    "/delivery — 设置「正在生成时又收到新消息」怎么处理（排队 / 立即打断，仅私聊）",
    "/config — 查看/修改运行时配置（群触发、流式等）",
    "/config <key> <value> — 设置白名单配置并立即生效",
    "/config clear [key|all] — 清除 runtime overrides",
    "/commands — 显示命令列表",
    "",
    "【Pi 流程命令】交回 Pi 执行（仅 Pi runtime，见 .pi/extensions/knowledge-flow）",
    "/learn [反馈原文] — 把反馈落成 .pi/ 下的规范改动（无参数则复盘本会话）",
    "/deploy-test [端名] — 测试环境部署（rust_server / quasar / quasar_h5 / quasar-offical-web / senlan-official-web）",
    "",
    "【透传给模型】/req、/kb、/test 在飞书里不派发命令处理，斜杠文本原样交给模型——直接说需求即可。",
  ].join("\n");
}

/** 合并用户文本与引用父消息，供 agent 调查告警卡片等场景 */
export function buildPromptWithQuote(userText: string, quoted?: { msgType: string; text: string } | null): string {
  if (!quoted?.text?.trim()) return userText;
  const blocks = [
    "[Quoted message]",
    `type: ${quoted.msgType}`,
    "---",
    quoted.text.trim(),
    "---",
    "[User]",
    userText || "(no text)",
  ];
  return blocks.join("\n");
}

function resolvePostBody(post: unknown): PostBody | undefined {
  if (isPostBody(post)) return post;
  if (!post || typeof post !== "object" || Array.isArray(post)) return undefined;

  const record = post as Record<string, unknown>;
  const candidates = [record.zh_cn, record.en_us, ...Object.values(record)];
  return candidates.find(isPostBody);
}

function isPostBody(value: unknown): value is PostBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.content);
}

function extractPostText(node: unknown, attachments: FeishuAttachment[]): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.map((item) => extractPostText(item, attachments)).join("");

  const obj = node as Record<string, unknown>;
  const tag = typeof obj.tag === "string" ? obj.tag : undefined;

  if ((tag === "img" || tag === "image") && typeof obj.image_key === "string" && obj.image_key) {
    attachments.push({ kind: "image", fileKey: obj.image_key });
    return "";
  }

  if (tag === "at") {
    // @ 人占位：不保留名字，避免给模型引入无意义噪音
    return "";
  }

  // 有序列表 / 无序列表：飞书 post 常见 tag，避免 #4 空解析
  if (tag === "ol" || tag === "ul" || tag === "li") {
    return Object.values(obj)
      .map((item) => extractPostText(item, attachments))
      .join(tag === "li" ? "\n" : "");
  }

  if ((tag === "text" || tag === "a") && typeof obj.text === "string") {
    return obj.text;
  }

  if (typeof obj.text === "string") return obj.text;

  return Object.values(obj)
    .map((item) => extractPostText(item, attachments))
    .join("");
}

function collectAttachments(value: unknown, attachments: FeishuAttachment[]) {
  const seen = new Set(attachments.map((item) => `${item.kind}:${item.fileKey}`));
  walk(value);

  function add(attachment: FeishuAttachment) {
    const key = `${attachment.kind}:${attachment.fileKey}`;
    if (seen.has(key)) return;
    seen.add(key);
    attachments.push(attachment);
  }

  function walk(node: unknown) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const obj = node as Record<string, unknown>;
    if (typeof obj.image_key === "string" && obj.image_key) {
      add({ kind: "image", fileKey: obj.image_key });
    }
    if (typeof obj.file_key === "string" && obj.file_key) {
      add({
        kind: "file",
        fileKey: obj.file_key,
        fileName: typeof obj.file_name === "string" ? obj.file_name : undefined,
      });
    }

    for (const item of Object.values(obj)) walk(item);
  }
}
