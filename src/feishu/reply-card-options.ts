/**
 * 回复卡的流式/过程展示配置解析（纯函数，无 IO 之外的状态）。
 *
 * 从 reply-card.ts 抽出来的一层：这里只回答「卡片该怎么发」，
 * reply-card.ts 只负责「按这套参数把卡片编排出去」。
 *
 * 取值优先级：调用方显式 override > 环境变量 > runtime 配置 > 内置默认。
 * runtime 配置可由飞书 `/config` 或 Pi `/feishu progress` 热更新。
 */
import { loadConfig, runtimeEnv } from "./config.ts";

export type ReplyCardStreamOptions = {
  enabled?: boolean;
  /** CardKit 客户端打印间隔 ms（默认 50） */
  printFrequencyMs?: number;
  /** CardKit 每次打印字符数（默认 1） */
  printStep?: number;
  /** 服务端推送 fullText 到 CardKit 的间隔 ms（默认 120） */
  pushIntervalMs?: number;
  /** 工具过程展示档位（默认取配置，配置缺省 steps） */
  progressMode?: "off" | "steps" | "action" | "timeout";
  /** 清单最多保留多少行（默认 50） */
  progressMaxLines?: number;
  /** 超过该秒数才显示耗时（默认 30） */
  progressTimeoutSeconds?: number;
};

export function resolveStreamOptions(override?: ReplyCardStreamOptions) {
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
    // 默认 off：不展示工具过程；想看过程用 /config progressMode <steps|action|timeout> 打开
    progressMode: override?.progressMode ?? cfg?.progressMode ?? "off",
    progressMaxLines: clampInt(override?.progressMaxLines ?? cfg?.progressMaxLines ?? 50, 3, 100),
    progressTimeoutSeconds: Math.max(
      1,
      override?.progressTimeoutSeconds ?? cfg?.progressTimeoutSeconds ?? 30,
    ),
  };
}

function clampInt(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function parseEnvInt(name: string): number | undefined {
  const v = runtimeEnv(name)?.trim();
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}
