import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseGroupKeywords } from "./group-trigger.ts";
import { instanceWebhookPort, LEGACY_GLOBAL_ROOT_DIR, normalizeDir, OWNER_WORKSPACE_FILE, readOwnerWorkspaceAt, resolveRootDir } from "./instance.ts";
import { applyRuntimeOverrides, getRuntimeOverrides, setRuntimeOverridesPath } from "./runtime-config.ts";
import type { CardActionMode, Domain, FeishuConfig, GroupPolicy, LearnApprovalConfig } from "./types.ts";

/**
 * Feishu 数据根目录。**跟着工作区走**：默认 `<工作区根>/.pi/feishu`，
 * 设了 `FEISHU_DATA_DIR` 则用显式值（见 instance.ts）。
 */
export const ROOT_DIR = resolveRootDir();

// ---------- Pi 适配器路径 ----------
export const CONFIG_PI_PATH = join(ROOT_DIR, "config.pi.json");
export const STATE_PI_PATH = join(ROOT_DIR, "state.pi.json");
export const BRIDGE_PI_PATH = join(ROOT_DIR, "bridge.pi.json");
export const DEDUPE_PI_PATH = join(ROOT_DIR, "dedupe.pi.json");
export const DEBUG_PI_LOG_PATH = join(ROOT_DIR, "debug.pi.log");
export const DAEMON_LOG_PATH = join(ROOT_DIR, "daemon.log");

// ---------- 兼容旧引用（等价于 Pi 版） ----------
export const CONFIG_PATH = CONFIG_PI_PATH;
export const STATE_PATH = STATE_PI_PATH;
export const BRIDGE_PATH = BRIDGE_PI_PATH;
export const DEDUPE_PATH = DEDUPE_PI_PATH;
export const DEBUG_LOG_PATH = DEBUG_PI_LOG_PATH;

export const CHILD_SESSION_ENV = "PI_FEISHU_CHILD_SESSION";

/**
 * Agent Runtime 的配置/状态/记录文件集合。
 * 本仓只有 Pi 一个 runtime，这层间接只是让公共代码通过 loadConfig/debugLog
 * 取文件时不必散落常量。
 */
export type RuntimeSource = {
  id: "pi";
  /** 环境变量前缀：FEISHU_ */
  envPrefix: string;
  configPath: string;
  statePath: string;
  bridgePath: string;
  dedupePath: string;
  debugLogPath: string;
};

export const PI_SOURCE: RuntimeSource = {
  id: "pi",
  envPrefix: "FEISHU",
  configPath: CONFIG_PI_PATH,
  statePath: STATE_PI_PATH,
  bridgePath: BRIDGE_PI_PATH,
  dedupePath: DEDUPE_PI_PATH,
  debugLogPath: DEBUG_PI_LOG_PATH,
};

/** 默认 Pi（向后兼容：Pi 进程无需显式设置）。 */
let currentSource: RuntimeSource = PI_SOURCE;

export function setRuntimeSource(source: RuntimeSource) {
  currentSource = source;
  // 运行时热更新配置落在实例目录里
  setRuntimeOverridesPath(join(ROOT_DIR, "runtime-overrides.json"));
}

export function getRuntimeSource(): RuntimeSource {
  return currentSource;
}

/** 按当前 runtime 的环境变量前缀读取（如 STREAM_PRINT_FREQUENCY_MS → FEISHU_STREAM_PRINT_FREQUENCY_MS）。 */
export function runtimeEnv(name: string): string | undefined {
  return process.env[`${currentSource.envPrefix}_${name}`];
}

export const DEFAULT_CONFIG: Pick<
  FeishuConfig,
  | "domain"
  | "groupPolicy"
  | "groupKeywords"
  | "groupAlsoOnReply"
  | "ignoreBotMessages"
  | "cardActionMode"
  | "cardActionWebhookHost"
  | "cardActionWebhookPort"
  | "cardActionWebhookPath"
  | "language"
  | "reactEmoji"
  | "autoStart"
  | "parseInteractiveCards"
  | "includeQuotedMessage"
  | "quotedMessageMaxChars"
  | "promptNotifySec"
  | "promptTimeoutSec"
  | "sendMaxRetries"
  | "streamingReply"
  | "streamPrintFrequencyMs"
  | "streamPrintStep"
  | "streamPushIntervalMs"
  | "streamFlushMs"
  | "streamFirstFlushMs"
  | "streamMinChars"
  | "streamMaxBodyChars"
  | "messageDelivery"
> = {
  domain: "feishu",
  groupPolicy: "open",
  groupKeywords: [],
  groupAlsoOnReply: false,
  ignoreBotMessages: true,
  cardActionMode: "webhook",
  cardActionWebhookHost: "0.0.0.0",
  // 默认端口，实际值由 defaultCardActionWebhookPort() 按实例目录派生
  cardActionWebhookPort: 3001,
  cardActionWebhookPath: "/webhook/card",
  language: "zh",
  reactEmoji: "Get",
  autoStart: true,
  parseInteractiveCards: true,
  includeQuotedMessage: true,
  quotedMessageMaxChars: 8000,
  promptNotifySec: 180,
  promptTimeoutSec: 0,
  sendMaxRetries: 2,
  streamingReply: true,
  // 正在生成时又收到新消息：默认排队（与历史行为一致），可改 interrupt 立即打断
  messageDelivery: "queue",
  // CardKit 客户端逐字打印
  streamPrintFrequencyMs: 50,
  streamPrintStep: 1,
  streamPushIntervalMs: 120,
  // 兼容旧 message.patch 参数（CardKit 路径基本忽略）
  streamFlushMs: 350,
  streamFirstFlushMs: 50,
  streamMinChars: 8,
  streamMaxBodyChars: 12000,
};

/**
 * 卡片回调端口：按实例目录稳定派生到 3003-3099，
 * 避免同一台机器上多个工作区在同一个端口上互抢；
 * 显式 `FEISHU_CARD_ACTION_WEBHOOK_PORT` 优先。
 */
export function defaultCardActionWebhookPort(): number {
  return instanceWebhookPort(3001);
}

export function ensureRoot() {
  migrateLegacyGlobalInstance();
  mkdirSync(ROOT_DIR, { recursive: true });
  migrateLegacyFiles();
}

/**
 * 把 0.5.x 的全局实例数据搬到工作区实例目录（0.6.0 起实例跟着工作区走，不再有全局实例）。
 *
 * 三个条件同时成立才搬，避免偷走别的工作区的数据：
 * 1. 没有显式指定 `FEISHU_DATA_DIR`；
 * 2. 本工作区实例目录还不存在，而旧全局目录存在；
 * 3. 旧全局目录里的属主工作区记录就是本工作区。
 *
 * 用 rename（同盘瞬间完成），失败只打印提示、不做任何删除。
 *
 * 属主判定用**严格相等**（不是 sameWorkspace 的「子目录也算同一工作区」）：
 * 迁移是真移动，宁可漏搬也不能错搬 —— 在子目录（例如 `.pi/ax-feishu-bridge`）里
 * 跑一次程序就把父工作区的实例数据搬进子目录，是很贵的错误。
 */
function migrateLegacyGlobalInstance() {
  if (existsSync(ROOT_DIR) || !existsSync(LEGACY_GLOBAL_ROOT_DIR)) return;
  // 测试进程绝不搬真实数据（测试里到处都会 ensureRoot()，而 cwd/HOME 都不是真实工作区）
  if (isTestProcess()) return;
  const owner = readOwnerWorkspaceAt(join(LEGACY_GLOBAL_ROOT_DIR, OWNER_WORKSPACE_FILE));
  if (!owner || normalizeDir(owner) !== normalizeDir(process.cwd())) {
    console.error(
      `[feishu] 检测到旧全局实例目录 ${LEGACY_GLOBAL_ROOT_DIR}（属主：${owner ?? "未知"}），不属于本工作区（当前 ${process.cwd()}），未自动搬迁。`,
    );
    return;
  }
  try {
    mkdirSync(dirname(ROOT_DIR), { recursive: true });
    renameSync(LEGACY_GLOBAL_ROOT_DIR, ROOT_DIR);
    console.error(`[feishu] 已把旧全局实例数据搬到工作区实例目录：${ROOT_DIR}`);
  } catch (error) {
    console.error(
      `[feishu] 搬迁旧全局实例数据失败（未做任何删除）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 是否跑在测试进程里（`node --test` 会设 NODE_TEST_CONTEXT）；测试不得移动真实实例数据。 */
function isTestProcess(): boolean {
  return Boolean(process.env.NODE_TEST_CONTEXT) || process.argv.includes("--test");
}

/**
 * 旧版本所有文件不带 runtime 后缀；首次运行新版本时把旧文件改名为 Pi 版，
 * 避免丢失已有配置/会话绑定。
 */
function migrateLegacyFiles() {
  migrateFile("state.json", STATE_PI_PATH);
  migrateFile("config.json", CONFIG_PI_PATH);
  migrateFile("bridge.json", BRIDGE_PI_PATH);
  migrateFile("dedupe.json", DEDUPE_PI_PATH);
}

function migrateFile(legacyName: string, targetPath: string) {
  const legacyPath = join(ROOT_DIR, legacyName);
  if (!existsSync(legacyPath) || existsSync(targetPath)) return;
  try {
    renameSync(legacyPath, targetPath);
  } catch {}
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {}
}

export function removePath(path: string) {
  rmSync(path, { recursive: true, force: true });
}

function parseBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(v)) return true;
    if (["0", "false", "no", "off"].includes(v)) return false;
  }
  return fallback;
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function parseEnvSeconds(value: string | undefined) {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function numberOr(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function applyRuntimeDefaults(cfg: FeishuConfig): FeishuConfig {
  return {
    ...cfg,
    learnApproval: parseLearnApproval(cfg.learnApproval),
    groupKeywords: Array.isArray(cfg.groupKeywords)
      ? parseGroupKeywords(cfg.groupKeywords)
      : (cfg.groupKeywords ?? DEFAULT_CONFIG.groupKeywords),
    groupAlsoOnReply: cfg.groupAlsoOnReply ?? DEFAULT_CONFIG.groupAlsoOnReply,
    ignoreBotMessages: cfg.ignoreBotMessages ?? DEFAULT_CONFIG.ignoreBotMessages,
    parseInteractiveCards: cfg.parseInteractiveCards ?? DEFAULT_CONFIG.parseInteractiveCards,
    includeQuotedMessage: cfg.includeQuotedMessage ?? DEFAULT_CONFIG.includeQuotedMessage,
    quotedMessageMaxChars: cfg.quotedMessageMaxChars ?? DEFAULT_CONFIG.quotedMessageMaxChars,
    promptNotifySec: numberOr(cfg.promptNotifySec, DEFAULT_CONFIG.promptNotifySec!),
    promptTimeoutSec: numberOr(cfg.promptTimeoutSec, DEFAULT_CONFIG.promptTimeoutSec!),
    sendMaxRetries: cfg.sendMaxRetries ?? DEFAULT_CONFIG.sendMaxRetries,
    streamingReply: cfg.streamingReply ?? DEFAULT_CONFIG.streamingReply,
    messageDelivery: cfg.messageDelivery ?? DEFAULT_CONFIG.messageDelivery,
    streamPrintFrequencyMs: cfg.streamPrintFrequencyMs ?? DEFAULT_CONFIG.streamPrintFrequencyMs,
    streamPrintStep: cfg.streamPrintStep ?? DEFAULT_CONFIG.streamPrintStep,
    streamPushIntervalMs: cfg.streamPushIntervalMs ?? DEFAULT_CONFIG.streamPushIntervalMs,
    streamFlushMs: cfg.streamFlushMs ?? DEFAULT_CONFIG.streamFlushMs,
    streamFirstFlushMs: cfg.streamFirstFlushMs ?? DEFAULT_CONFIG.streamFirstFlushMs,
    streamMinChars: cfg.streamMinChars ?? DEFAULT_CONFIG.streamMinChars,
    streamMaxBodyChars: cfg.streamMaxBodyChars ?? DEFAULT_CONFIG.streamMaxBodyChars,
  };
}

export function loadConfig(): FeishuConfig | undefined {
  const base = loadBaseConfig();
  if (!base) return undefined;
  // runtime-overrides 覆盖 env/config 中的白名单字段（热更新 + 落盘）
  return applyRuntimeOverrides(base, getRuntimeOverrides());
}

/** 不含 runtime overrides 的基础配置（env 或 config.json） */
export function loadBaseConfig(): FeishuConfig | undefined {
  const source = getRuntimeSource();
  const env = (name: string) => process.env[`${source.envPrefix}_${name}`];
  const envAppId = env("APP_ID")?.trim();
  const envSecret = env("APP_SECRET")?.trim();
  if (envAppId && envSecret) {
    return applyRuntimeDefaults({
      appId: envAppId,
      appSecret: envSecret,
      domain: (env("DOMAIN") as Domain) || DEFAULT_CONFIG.domain,
      groupPolicy: (env("GROUP_POLICY") as GroupPolicy) || DEFAULT_CONFIG.groupPolicy,
      groupKeywords: parseGroupKeywords(env("GROUP_KEYWORDS")),
      groupAlsoOnReply: parseBool(env("GROUP_ALSO_ON_REPLY"), DEFAULT_CONFIG.groupAlsoOnReply!),
      ignoreBotMessages: parseBool(env("IGNORE_BOT_MESSAGES"), DEFAULT_CONFIG.ignoreBotMessages!),
      cardActionMode: parseCardActionMode(env("CARD_ACTION_MODE")) || DEFAULT_CONFIG.cardActionMode,
      cardActionWebhookHost: env("CARD_ACTION_WEBHOOK_HOST")?.trim() || DEFAULT_CONFIG.cardActionWebhookHost,
      cardActionWebhookPort: parsePort(env("CARD_ACTION_WEBHOOK_PORT")) ?? defaultCardActionWebhookPort(),
      cardActionWebhookPath: normalizeWebhookPath(env("CARD_ACTION_WEBHOOK_PATH")) || DEFAULT_CONFIG.cardActionWebhookPath,
      language: (env("LANGUAGE") as "zh" | "en") || DEFAULT_CONFIG.language,
      reactEmoji: env("REACT_EMOJI") || DEFAULT_CONFIG.reactEmoji,
      autoStart: env("AUTO_START") ? env("AUTO_START") !== "0" : DEFAULT_CONFIG.autoStart,
      parseInteractiveCards: parseBool(env("PARSE_INTERACTIVE_CARDS"), DEFAULT_CONFIG.parseInteractiveCards!),
      includeQuotedMessage: parseBool(env("INCLUDE_QUOTED_MESSAGE"), DEFAULT_CONFIG.includeQuotedMessage!),
      quotedMessageMaxChars: parsePositiveInt(env("QUOTED_MESSAGE_MAX_CHARS"), DEFAULT_CONFIG.quotedMessageMaxChars!),
      promptNotifySec: parseEnvSeconds(env("PROMPT_NOTIFY_SEC")) ?? DEFAULT_CONFIG.promptNotifySec!,
      promptTimeoutSec: parseEnvSeconds(env("PROMPT_TIMEOUT_SEC")) ?? DEFAULT_CONFIG.promptTimeoutSec!,
      sendMaxRetries: parsePositiveInt(env("SEND_MAX_RETRIES"), DEFAULT_CONFIG.sendMaxRetries!),
      streamingReply: parseBool(env("STREAMING_REPLY"), DEFAULT_CONFIG.streamingReply!),
      streamPrintFrequencyMs: parsePositiveInt(env("STREAM_PRINT_FREQUENCY_MS"), DEFAULT_CONFIG.streamPrintFrequencyMs!),
      streamPrintStep: parsePositiveInt(env("STREAM_PRINT_STEP"), DEFAULT_CONFIG.streamPrintStep!),
      streamPushIntervalMs: parsePositiveInt(env("STREAM_PUSH_INTERVAL_MS"), DEFAULT_CONFIG.streamPushIntervalMs!),
      streamFlushMs: parsePositiveInt(env("STREAM_FLUSH_MS"), DEFAULT_CONFIG.streamFlushMs!),
      streamFirstFlushMs: parsePositiveInt(env("STREAM_FIRST_FLUSH_MS"), DEFAULT_CONFIG.streamFirstFlushMs!),
      streamMinChars: parsePositiveInt(env("STREAM_MIN_CHARS"), DEFAULT_CONFIG.streamMinChars!),
      streamMaxBodyChars: parsePositiveInt(env("STREAM_MAX_BODY_CHARS"), DEFAULT_CONFIG.streamMaxBodyChars!),
      // 进化审批：环境变量只提供 approval_code，超时/轮询间隔走默认值
      learnApproval: parseLearnApproval(
        env("LEARN_APPROVAL_CODE") ? { approvalCode: env("LEARN_APPROVAL_CODE") } : undefined,
      ),
    });
  }
  if (!existsSync(source.configPath)) return undefined;
  const cfg = readJson<Partial<FeishuConfig>>(source.configPath, {});
  if (!cfg.appId || !cfg.appSecret) return undefined;
  return applyRuntimeDefaults({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    domain: cfg.domain || DEFAULT_CONFIG.domain,
    groupPolicy: cfg.groupPolicy || DEFAULT_CONFIG.groupPolicy,
    groupKeywords: parseGroupKeywords(cfg.groupKeywords),
    groupAlsoOnReply: parseBool(cfg.groupAlsoOnReply, DEFAULT_CONFIG.groupAlsoOnReply!),
    ignoreBotMessages: parseBool(cfg.ignoreBotMessages, DEFAULT_CONFIG.ignoreBotMessages!),
    cardActionMode: parseCardActionMode(cfg.cardActionMode) || DEFAULT_CONFIG.cardActionMode,
    cardActionWebhookHost: cfg.cardActionWebhookHost || DEFAULT_CONFIG.cardActionWebhookHost,
    cardActionWebhookPort: typeof cfg.cardActionWebhookPort === "number" ? cfg.cardActionWebhookPort : defaultCardActionWebhookPort(),
    cardActionWebhookPath: normalizeWebhookPath(cfg.cardActionWebhookPath) || DEFAULT_CONFIG.cardActionWebhookPath,
    language: cfg.language || DEFAULT_CONFIG.language,
    reactEmoji: cfg.reactEmoji || DEFAULT_CONFIG.reactEmoji,
    autoStart: cfg.autoStart ?? DEFAULT_CONFIG.autoStart,
    parseInteractiveCards: cfg.parseInteractiveCards,
    includeQuotedMessage: cfg.includeQuotedMessage,
    quotedMessageMaxChars: cfg.quotedMessageMaxChars,
    promptNotifySec: numberOr(cfg.promptNotifySec, DEFAULT_CONFIG.promptNotifySec!),
    promptTimeoutSec: numberOr(cfg.promptTimeoutSec, DEFAULT_CONFIG.promptTimeoutSec!),
    sendMaxRetries: cfg.sendMaxRetries,
    streamingReply: cfg.streamingReply,
    messageDelivery: cfg.messageDelivery,
    streamPrintFrequencyMs: cfg.streamPrintFrequencyMs,
    streamPrintStep: cfg.streamPrintStep,
    streamPushIntervalMs: cfg.streamPushIntervalMs,
    streamFlushMs: cfg.streamFlushMs,
    streamFirstFlushMs: cfg.streamFirstFlushMs,
    streamMinChars: cfg.streamMinChars,
    streamMaxBodyChars: cfg.streamMaxBodyChars,
    learnApproval: parseLearnApproval(cfg.learnApproval),
  });
}

function parseCardActionMode(value: unknown): CardActionMode | undefined {
  if (value !== "webhook" && value !== "ws") return undefined;
  return value;
}

/**
 * 解析进化审批配置。
 * approvalCode 是必需项：没有它就说明用户还没在飞书审批后台建好审批定义，
 * 此时整个 learnApproval 视为未配置，/learn 应用 会明确提示去配。
 */
export function parseLearnApproval(value: unknown): LearnApprovalConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const approvalCode = typeof raw.approvalCode === "string" ? raw.approvalCode.trim() : "";
  if (!approvalCode) return undefined;
  return {
    approvalCode,
    timeoutSec: typeof raw.timeoutSec === "number" && raw.timeoutSec > 0 ? Math.floor(raw.timeoutSec) : undefined,
    pollIntervalSec:
      typeof raw.pollIntervalSec === "number" && raw.pollIntervalSec > 0 ? Math.floor(raw.pollIntervalSec) : undefined,
  };
}

function parsePort(value: string | undefined) {
  if (!value) return undefined;
  const port = Number.parseInt(value, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return undefined;
  return port;
}

function normalizeWebhookPath(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function mask(s: string) {
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}
