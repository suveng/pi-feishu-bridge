import { debugLog } from "./debug.ts";

export type RetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  label?: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetriableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    const msg = String(error || "").toLowerCase();
    return msg.includes("timeout") || msg.includes("econnreset") || msg.includes("socket");
  }
  const err = error as {
    code?: number | string;
    status?: number;
    message?: string;
    response?: { status?: number; data?: { code?: number; msg?: string } };
    cause?: unknown;
  };
  const status = err.status ?? err.response?.status;
  if (typeof status === "number" && (status === 429 || status >= 500)) return true;

  const code = err.code ?? err.response?.data?.code;
  if (code === 11310 || code === 99991400 || code === 99991429) return true;
  if (typeof code === "string") {
    const c = code.toUpperCase();
    if (["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "ENOTFOUND", "EPIPE"].includes(c)) return true;
  }

  const msg = `${err.message || ""} ${err.response?.data?.msg || ""}`.toLowerCase();
  if (msg.includes("timeout") || msg.includes("rate") || msg.includes("temporarily") || msg.includes("try again")) {
    return true;
  }
  // Node 内置 fetch 的网络层失败统一报 "fetch failed"，真实原因在 cause 里；
  // 有 cause 时递归判断 cause，没有 cause 也按可重试处理，避免卡收尾直接放弃。
  if (msg.includes("fetch failed")) {
    return true;
  }
  if (err.cause && err.cause !== error) return isRetriableError(err.cause);
  return false;
}

export type BackoffRetryOptions = {
  /** 每次失败后的等待毫秒数；数组长度 = 允许的重试次数（首次尝试不算） */
  delaysMs: number[];
  /** 判断错误是否值得重试，默认 isRetriableError */
  isRetriable?: (error: unknown) => boolean;
  /** 每次决定重试时回调，便于调用方打日志/改状态 */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
};

/**
 * 按给定延迟序列重试（用于「启动期一次性初始化」这类不该一次失败就放弃的流程）。
 * 延迟序列由调用方给定，便于把总时长控制在网关锁 stale 阈值（30s）以内。
 * 不可重试错误（凭证错、403、999xxxxx）立即抛出，不浪费等待时间。
 */
export async function withBackoffRetry<T>(fn: () => Promise<T>, options: BackoffRetryOptions): Promise<T> {
  const { delaysMs, isRetriable = isRetriableError, onRetry } = options;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= delaysMs.length || !isRetriable(error)) throw error;
      const delayMs = delaysMs[attempt];
      onRetry?.(error, attempt + 1, delayMs);
      await sleep(delayMs);
    }
  }
}

/** 带指数退避的重试；不可重试错误立即抛出 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = Math.max(0, options.maxRetries ?? 2);
  const baseDelayMs = options.baseDelayMs ?? 300;
  const label = options.label || "feishu.retry";
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retriable = isRetriableError(error);
      if (!retriable || attempt >= maxRetries) throw error;
      const delay = baseDelayMs * Math.pow(2, attempt);
      debugLog(label, {
        attempt: attempt + 1,
        maxRetries,
        delayMs: delay,
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(delay);
    }
  }
  throw lastError;
}

