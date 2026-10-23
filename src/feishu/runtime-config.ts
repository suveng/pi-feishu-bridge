import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseGroupKeywords } from "./group-trigger.ts";
import { resolveRootDir } from "./instance.ts";

/** 运行时可改配置白名单（不含密钥/连接通道） */
export const RUNTIME_CONFIG_KEYS = [
  "groupPolicy",
  "groupKeywords",
  "groupAlsoOnReply",
  "ignoreBotMessages",
  "reactEmoji",
  "language",
  "streamingReply",
  "streamPrintFrequencyMs",
  "streamPrintStep",
  "streamPushIntervalMs",
  "messageDelivery",
  "progressMode",
  "progressMaxLines",
  "progressTimeoutSeconds",
] as const;

export type RuntimeConfigKey = (typeof RUNTIME_CONFIG_KEYS)[number];

/** 最小配置形状，避免 runtime-config → types 的 type-only import 触发 strip-types 问题 */
export type RuntimeConfigView = {
  groupPolicy?: "open" | "mention";
  groupKeywords?: string[];
  groupAlsoOnReply?: boolean;
  ignoreBotMessages?: boolean;
  reactEmoji?: string;
  language?: "zh" | "en";
  streamingReply?: boolean;
  streamPrintFrequencyMs?: number;
  streamPrintStep?: number;
  streamPushIntervalMs?: number;
  /**
   * 正在生成回复时又收到新消息的处理方式：
   * - queue（默认）：排队，等上一条跑完再处理（当前行为）
   * - interrupt：立即打断当前生成，用新消息开新一轮
   */
  messageDelivery?: "queue" | "interrupt";
  /**
   * 工具执行过程展示档位（默认 off）：
   * - off：不展示，等价于改造前
   * - steps：累积清单（工具名 + 命令 + 耗时 + 成败）
   * - action：只显示当前这一个工具
   * - timeout：平时不显示，单个工具超阈值才提示
   */
  progressMode?: "off" | "steps" | "action" | "timeout";
  /** 清单最多保留多少行，超出折叠（默认 50） */
  progressMaxLines?: number;
  /** 超过该秒数才显示耗时（默认 30） */
  progressTimeoutSeconds?: number;
  [key: string]: unknown;
};

export type RuntimeOverrides = Partial<Pick<RuntimeConfigView, RuntimeConfigKey>>;

// 实例目录由 instance.ts 统一解析，不要在这里再硬编码 ~/.pi/agent/feishu
const FEISHU_ROOT = resolveRootDir();
export const RUNTIME_OVERRIDES_PATH = join(FEISHU_ROOT, "runtime-overrides.json");

/** 当前 runtime 的 overrides 落盘路径；默认 Pi，由 setRuntimeOverridesPath 切换 */
let currentOverridesPath = RUNTIME_OVERRIDES_PATH;

export function setRuntimeOverridesPath(path: string) {
  currentOverridesPath = path;
}

export function runtimeOverridesPath(): string {
  return currentOverridesPath;
}

export function isRuntimeConfigKey(key: string): key is RuntimeConfigKey {
  return (RUNTIME_CONFIG_KEYS as readonly string[]).includes(key);
}

export type ParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export function parseRuntimeConfigValue(key: string, raw: string): ParseResult {
  if (!isRuntimeConfigKey(key)) {
    return { ok: false, error: `不允许修改配置项: ${key}` };
  }
  const text = raw.trim();
  switch (key) {
    case "groupKeywords":
      return { ok: true, value: parseGroupKeywords(text) };
    case "groupPolicy": {
      if (text !== "open" && text !== "mention") {
        return { ok: false, error: "groupPolicy 仅支持 open | mention" };
      }
      return { ok: true, value: text as "open" | "mention" };
    }
    case "language": {
      if (text !== "zh" && text !== "en") {
        return { ok: false, error: "language 仅支持 zh | en" };
      }
      return { ok: true, value: text };
    }
    case "messageDelivery": {
      if (text !== "queue" && text !== "interrupt") {
        return { ok: false, error: "messageDelivery 仅支持 queue | interrupt" };
      }
      return { ok: true, value: text as "queue" | "interrupt" };
    }
    case "progressMode": {
      const allowed = ["off", "steps", "action", "timeout"] as const;
      if (!(allowed as readonly string[]).includes(text)) {
        return { ok: false, error: "progressMode 仅支持 off | steps | action | timeout" };
      }
      return { ok: true, value: text as (typeof allowed)[number] };
    }
    case "groupAlsoOnReply":
    case "ignoreBotMessages":
    case "streamingReply": {
      const b = parseBoolStrict(text);
      if (b === undefined) return { ok: false, error: `${key} 请使用 true/false/1/0` };
      return { ok: true, value: b };
    }
    case "reactEmoji": {
      if (!text) return { ok: false, error: "reactEmoji 不能为空" };
      return { ok: true, value: text };
    }
    case "streamPrintFrequencyMs":
    case "streamPrintStep":
    case "streamPushIntervalMs": {
      const n = Number.parseInt(text, 10);
      if (!Number.isFinite(n) || n <= 0) {
        return { ok: false, error: `${key} 必须是正整数` };
      }
      return { ok: true, value: n };
    }
    case "progressMaxLines": {
      const n = Number.parseInt(text, 10);
      if (!Number.isFinite(n) || n < 3 || n > 100) {
        return { ok: false, error: "progressMaxLines 必须是 3-100 的整数" };
      }
      return { ok: true, value: n };
    }
    case "progressTimeoutSeconds": {
      const n = Number.parseInt(text, 10);
      if (!Number.isFinite(n) || n <= 0) {
        return { ok: false, error: "progressTimeoutSeconds 必须是正整数" };
      }
      return { ok: true, value: n };
    }
    default:
      return { ok: false, error: `不允许修改配置项: ${key}` };
  }
}

function parseBoolStrict(value: string): boolean | undefined {
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return undefined;
}

function readOverridesFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeOverridesFile(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    // ignore chmod failures on non-posix volumes
  }
}

/** 将 overrides 合并进 base；忽略非白名单字段 */
export function applyRuntimeOverrides<T extends RuntimeConfigView>(
  base: T,
  overrides: RuntimeOverrides | Record<string, unknown>,
): T {
  const next = { ...base };
  for (const key of RUNTIME_CONFIG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(overrides, key)) continue;
    const value = (overrides as any)[key];
    if (value === undefined) continue;
    if (key === "groupKeywords") {
      (next as any).groupKeywords = parseGroupKeywords(value);
    } else {
      (next as any)[key] = value;
    }
  }
  return next;
}

export function getRuntimeOverrides(path: string = runtimeOverridesPath()): RuntimeOverrides {
  const raw = readOverridesFile(path);
  const out: RuntimeOverrides = {};
  for (const key of RUNTIME_CONFIG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const value = raw[key];
    if (value === undefined) continue;
    if (key === "groupKeywords") {
      out.groupKeywords = parseGroupKeywords(value);
    } else {
      (out as any)[key] = value;
    }
  }
  return out;
}

export type SetRuntimeResult =
  | { ok: true; key: RuntimeConfigKey; value: unknown; overrides: RuntimeOverrides }
  | { ok: false; error: string };

export function setRuntimeConfig(
  key: string,
  rawValue: string,
  options?: { path?: string },
): SetRuntimeResult {
  const parsed = parseRuntimeConfigValue(key, rawValue);
  if (parsed.ok === false) return { ok: false, error: parsed.error };
  const path = options?.path ?? runtimeOverridesPath();
  const current = getRuntimeOverrides(path);
  const next: RuntimeOverrides = {
    ...current,
    [key as RuntimeConfigKey]: parsed.value as any,
  };
  writeOverridesFile(path, next);
  return { ok: true, key: key as RuntimeConfigKey, value: parsed.value, overrides: next };
}

export function clearRuntimeOverrides(
  keyOrAll: RuntimeConfigKey | "all" | string,
  path: string = runtimeOverridesPath(),
): { ok: true; overrides: RuntimeOverrides } | { ok: false; error: string } {
  if (keyOrAll === "all") {
    writeOverridesFile(path, {});
    return { ok: true, overrides: {} };
  }
  if (!isRuntimeConfigKey(keyOrAll)) {
    return { ok: false, error: `不允许清除配置项: ${keyOrAll}` };
  }
  const current = { ...getRuntimeOverrides(path) };
  delete (current as any)[keyOrAll];
  writeOverridesFile(path, current);
  return { ok: true, overrides: current };
}

export function formatRuntimeConfig(cfg: RuntimeConfigView, overrides?: RuntimeOverrides): string {
  const ov = overrides ?? {};
  const mark = (key: RuntimeConfigKey) =>
    Object.prototype.hasOwnProperty.call(ov, key) ? " (override)" : "";

  const kw = (cfg.groupKeywords || []).join(", ") || "(空)";
  return [
    "⚙️ 飞书运行时配置（白名单）",
    "",
    `groupPolicy: ${cfg.groupPolicy}${mark("groupPolicy")}`,
    `groupKeywords: ${kw}${mark("groupKeywords")}`,
    `groupAlsoOnReply: ${Boolean(cfg.groupAlsoOnReply)}${mark("groupAlsoOnReply")}`,
    `ignoreBotMessages: ${cfg.ignoreBotMessages !== false}${mark("ignoreBotMessages")}`,
    `reactEmoji: ${cfg.reactEmoji || ""}${mark("reactEmoji")}`,
    `language: ${cfg.language || "zh"}${mark("language")}`,
    `streamingReply: ${cfg.streamingReply !== false}${mark("streamingReply")}`,
    `streamPrintFrequencyMs: ${cfg.streamPrintFrequencyMs ?? ""}${mark("streamPrintFrequencyMs")}`,
    `streamPrintStep: ${cfg.streamPrintStep ?? ""}${mark("streamPrintStep")}`,
    `streamPushIntervalMs: ${cfg.streamPushIntervalMs ?? ""}${mark("streamPushIntervalMs")}`,
    `messageDelivery: ${cfg.messageDelivery ?? "queue"}${mark("messageDelivery")}`,
    `progressMode: ${cfg.progressMode ?? "off"}${mark("progressMode")}`,
    `progressMaxLines: ${cfg.progressMaxLines ?? 50}${mark("progressMaxLines")}`,
    `progressTimeoutSeconds: ${cfg.progressTimeoutSeconds ?? 30}${mark("progressTimeoutSeconds")}`,
    "",
    "修改: /config <key> <value>",
    "也可直接发 /delivery 弹卡片切换 messageDelivery",
    "progressMode 也可用 Pi 侧 /feishu progress <值> 修改",
    "清除: /config clear <key|all>",
    `可改项: ${RUNTIME_CONFIG_KEYS.join(", ")}`,
  ].join("\n");
}

