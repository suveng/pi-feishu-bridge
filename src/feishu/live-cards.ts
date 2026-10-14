/**
 * 「进行中」卡片的进程级登记表 + 进程退出收尾。
 *
 * 背景（2026-10-14 生产事故）：重启桥接 daemon 时进程被 SIGTERM 直接终结，
 * 没有任何人给那张「回复中」的卡片收尾，飞书侧就永久停在「正在回复…」——
 * 用户以为任务还在跑，其实进程早就没了。
 * 「延迟到回复发完再重启」只能降低概率（回复没写完照样被杀），
 * 收尾才是确定性兜底：退出前把在册卡片翻成「已停止」并写明原因。
 */
import type { ReplyCardFinalStatus } from "./card-builder.ts";
import { debugLog } from "./debug.ts";

/** 收尾只需用到这两个成员，避免为此依赖具体的 ReplyCard 实现 */
export type LiveCardSink = {
  readonly runId: string;
  finish(status: ReplyCardFinalStatus, note?: string): Promise<void>;
};

/** 默认文案：必须让用户知道「不是卡住了，是服务重启了，重发即可」 */
export const INTERRUPTED_NOTE = "服务重启中，本轮回复已中断，请重发这条消息";

const live = new Set<LiveCardSink>();

export function registerLiveCard(sink: LiveCardSink): void {
  live.add(sink);
}

export function unregisterLiveCard(sink: LiveCardSink): void {
  live.delete(sink);
}

export function liveCardCount(): number {
  return live.size;
}

/** 只测试用：清空登记表，避免用例之间互相污染 */
export function resetLiveCards(): void {
  live.clear();
}

async function withTimeout(task: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      task,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`卡片收尾超时（${ms}ms）`)), ms);
      }),
    ]);
    return true;
  } catch (error) {
    debugLog("feishu.live_cards.finish_error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 把在册卡片全部收尾，返回成功条数。
 *
 * 先清册再收尾：收尾回调里可能又触发事件，重复进入会互相打架。
 * 单张卡超时/报错都不影响其他卡（退出路径上宁可少收一张，不能挂住不退）。
 */
export async function finishLiveCards(
  note: string = INTERRUPTED_NOTE,
  timeoutMs = 2500,
): Promise<number> {
  const pending = [...live];
  live.clear();
  if (pending.length === 0) return 0;
  console.error(`[feishu] 进程退出前收尾在册卡片 ${pending.length} 张`);
  const results = await Promise.all(
    pending.map((card) => withTimeout(card.finish("stopped", note), timeoutMs)),
  );
  const ok = results.filter(Boolean).length;
  debugLog("feishu.live_cards.finished_on_exit", { total: pending.length, ok, note });
  return ok;
}

export type ExitFlushOptions = {
  note?: string;
  timeoutMs?: number;
  exit?: (code: number) => void;
  terminate?: boolean;
};

/** 信号处理逻辑，抽成纯函数便于单测（不必真给进程发信号） */
export function createExitHandler(options: ExitFlushOptions = {}): () => void {
  const { note = INTERRUPTED_NOTE, timeoutMs = 2500, exit = (code) => process.exit(code), terminate = true } = options;
  return () => {
    void (async () => {
      try {
        await finishLiveCards(note, timeoutMs);
      } catch (error) {
        // 退出路径上绝不向上抛：抛出去就没人调 exit 了，进程会变成杀不死的僵尸
        debugLog("feishu.live_cards.exit_flush_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (terminate) exit(0);
      }
    })();
  };
}

let installed = false;

/**
 * 挂 SIGTERM / SIGINT 收尾（**只挂一次**：扩展模块可能被同进程重复加载）。
 *
 * 注意 `process.on(signal)` 会取消默认终止行为，所以 handler 里必须自己 exit；
 * createExitHandler 用 finally 保证这一点。
 */
export function installExitFlush(options: ExitFlushOptions & { signals?: NodeJS.Signals[] } = {}): void {
  if (installed) return;
  installed = true;
  const { signals = ["SIGTERM", "SIGINT"], ...rest } = options;
  const handler = createExitHandler(rest);
  for (const signal of signals) {
    process.on(signal, () => {
      console.error(`[feishu] 收到 ${signal}，开始退出收尾`);
      handler();
    });
  }
}
