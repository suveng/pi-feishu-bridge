/**
 * 飞书里的「无缝重启桥接」：票据 / 结果文件 / worker 拉起 / 重启后回执。
 *
 * 为什么要有 worker（而不是进程内 kill 自己再起）：
 * 1. 老进程要在死之前把「重启中」卡片发出去，发送完成才有回执可改；
 * 2. 新进程必须由**老进程之外**的人拉起 —— 老进程一死，没人执行 `startDaemon`；
 * 3. 新进程要等网关锁真正落到自己手上才算接管成功，这个等待只能发生在第三方。
 *
 * 回执由**新进程**补发（不是 worker）：新进程本来就有 transport 和 `bridge.pi.json`
 * 里的 chatId，不需要 worker 去读凭据换 token；worker 只做「杀→起→等锁→写结果」。
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ROOT_DIR, DAEMON_LOG_PATH } from "./config.ts";
import { daemonSpec } from "./daemon-spec.ts";
import { buildRestartCard } from "./cards.ts";
import { debugLog } from "./debug.ts";
import { gatewayLockPath } from "./gateway-lock.ts";
import type { FeishuTransport } from "./transport.ts";

export const RESTART_TICKET_PATH = `${ROOT_DIR}/restart-ticket.json`;
export const RESTART_RESULT_PATH = `${ROOT_DIR}/restart-result.json`;

/** 票据/结果的保鲜期：超过这个时间的残留一律当垃圾清掉，避免陈旧回执改错卡 */
export const RESTART_FRESH_MS = 180_000;

/** 触发重启的飞书消息上下文（用于回执定位卡片） */
export type RestartTrigger = {
  messageId: string;
  chatId: string;
};

export type RestartTicket = {
  version: 1;
  oldPid: number;
  /**
   * 老 daemon 的启动壳 pid —— 必须**在退出前**记下：老进程一退，它自己的 ppid 立刻被
   * reparent 成 1，worker 再去查就查不到了（修复前的旧版本漏掉的孤儿 tail 就是这么留下的）。
   */
  launcherPid?: number;
  cwd: string;
  piBin: string;
  args: string[];
  lockPath: string;
  logPath: string;
  resultPath: string;
  startedAt: number;
  commit?: string;
  triggerMessageId?: string;
  chatId?: string;
  cardMessageId?: string;
};

export type RestartResult = {
  version: 1;
  ok: boolean;
  at: number;
  newPid?: number;
  elapsedMs?: number;
  error?: string;
};

function readJson<T>(path: string): T | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJsonFile(path: string, value: unknown) {
  try {
    writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
  } catch (error) {
    debugLog("feishu.restart.write_failed", { path, error: error instanceof Error ? error.message : String(error) });
  }
}

export function readRestartTicket(path = RESTART_TICKET_PATH): RestartTicket | undefined {
  const ticket = readJson<RestartTicket>(path);
  return ticket && ticket.version === 1 ? ticket : undefined;
}

export function readRestartResult(path = RESTART_RESULT_PATH): RestartResult | undefined {
  const result = readJson<RestartResult>(path);
  return result && result.version === 1 ? result : undefined;
}

export function clearRestartFiles(ticketPath = RESTART_TICKET_PATH, resultPath = RESTART_RESULT_PATH) {
  for (const path of [ticketPath, resultPath]) {
    try {
      rmSync(path, { force: true });
    } catch {}
  }
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 当前代码版本，用于回执里告诉用户「重启后到底跑的是哪个 commit」 */
export function currentCommit(cwd: string): string | undefined {
  try {
    const res = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8", timeout: 3000 });
    const sha = res.stdout?.trim();
    if (!sha) return undefined;
    const subject = spawnSync("git", ["log", "-1", "--pretty=%s"], { cwd, encoding: "utf8", timeout: 3000 }).stdout?.trim();
    return subject ? `${sha} ${subject}` : sha;
  } catch {
    return undefined;
  }
}

/** `src/feishu/restart.ts` → `<pkg>/scripts/restart-worker.mjs` */
export function restartWorkerPath(): string {
  return fileURLToPath(new URL("../../scripts/restart-worker.mjs", import.meta.url));
}

/**
 * 拉起重启 worker（detached，老进程随后自行退出）。
 *
 * worker 用 `process.execPath` 跑，不依赖 PATH 里的 node —— 桥接可能由 nvm 里的
 * pi 拉起，PATH 在 detached 子进程里未必一致。
 */
export function spawnRestartWorker(ticket: RestartTicket, ticketPath = RESTART_TICKET_PATH): { ok: boolean; error?: string } {
  const worker = restartWorkerPath();
  if (!existsSync(worker)) return { ok: false, error: `重启 worker 不存在：${worker}` };
  let logFd: number | undefined;
  try {
    logFd = openSync(ticket.logPath, "a");
    const child = spawn(process.execPath, [worker, ticketPath], {
      detached: true,
      cwd: ticket.cwd,
      env: { ...process.env, PI_FEISHU_RESTART_WORKER: "1" },
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    debugLog("feishu.restart.worker_spawned", { pid: child.pid, ticketPath });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (typeof logFd === "number") {
      try { closeSync(logFd); } catch {}
    }
  }
}

/** 票据/结果落点（测试可覆盖，避免往真实 agent 目录写垃圾） */
export type RestartPaths = { ticketPath: string; resultPath: string };

const DEFAULT_PATHS: RestartPaths = { ticketPath: RESTART_TICKET_PATH, resultPath: RESTART_RESULT_PATH };

export type RequestRestartOptions = {
  transport: FeishuTransport;
  trigger: RestartTrigger;
  extensionPath: string;
  cwd?: string;
  hasActiveRun?: boolean;
  force?: boolean;
  paths?: RestartPaths;
  /** 默认 detach 拉起 scripts/restart-worker.mjs；测试注入桩，避免真起进程 */
  spawnWorker?: (ticket: RestartTicket, ticketPath: string) => { ok: boolean; error?: string };
};

/**
 * 处理 `/restart`：发「重启中」卡片 → 落票据 → 拉 worker。
 *
 * 注意 **顺序**：卡片必须先发出去并且拿到 message_id，票据才可能有回执地址；
 * 反过来先杀进程，用户就只会看到一张永远停在「回复中」的卡。
 */
export async function requestRestart(options: RequestRestartOptions): Promise<{ ok: boolean; error?: string; cardMessageId?: string }> {
  const cwd = options.cwd ?? process.cwd();
  const paths = options.paths ?? DEFAULT_PATHS;
  const spawnWorker = options.spawnWorker ?? spawnRestartWorker;
  if (options.hasActiveRun && !options.force) {
    return { ok: false, error: "当前还有回复在生成。等它结束再试，或发 `/restart force` 强制中止并重启。" };
  }
  const spec = daemonSpec(options.extensionPath);
  const startedAt = Date.now();
  const commit = currentCommit(cwd);

  let cardMessageId: string | undefined;
  try {
    cardMessageId = await options.transport.replyCard(
      options.trigger.messageId,
      buildRestartCard({ stage: "restarting", commit, at: startedAt }),
    );
  } catch (error) {
    return { ok: false, error: `重启卡片发送失败：${error instanceof Error ? error.message : String(error)}` };
  }

  const ticket: RestartTicket = {
    version: 1,
    oldPid: process.pid,
    launcherPid: process.ppid > 1 ? process.ppid : undefined,
    cwd,
    piBin: spec.piBin,
    args: spec.args,
    lockPath: gatewayLockPath(),
    logPath: DAEMON_LOG_PATH,
    resultPath: paths.resultPath,
    startedAt,
    commit,
    triggerMessageId: options.trigger.messageId,
    chatId: options.trigger.chatId,
    cardMessageId,
  };
  writeJsonFile(paths.ticketPath, ticket);
  try {
    rmSync(paths.resultPath, { force: true });
  } catch {}

  const spawned = spawnWorker(ticket, paths.ticketPath);
  if (!spawned.ok) {
    clearRestartFiles(paths.ticketPath, paths.resultPath);
    if (cardMessageId) {
      await options.transport
        .updateCard(cardMessageId, buildRestartCard({ stage: "failed", error: spawned.error || "worker 启动失败", at: Date.now() }))
        .catch(() => undefined);
    }
    return { ok: false, error: spawned.error };
  }
  return { ok: true, cardMessageId };
}

/**
 * 新进程接管成功后补发回执（也用于兜底：worker 半路死了但新进程起来了）。
 *
 * 判定：结果文件存在且在保鲜期内 → 按结果改卡；只有票据没有结果，且票据里的老 pid
 * 已经死了 → 说明我们就是重启后的新进程，改卡说明「回执缺失」。老 pid 还活着时**不动**
 * 票据：那意味着重启还没发生（worker 卡住），此时把卡改成「已重启」是撒谎。
 */
export async function ackRestartIfPending(transport: FeishuTransport, paths: RestartPaths = DEFAULT_PATHS): Promise<boolean> {
  const ticket = readRestartTicket(paths.ticketPath);
  const result = readRestartResult(paths.resultPath);
  const now = Date.now();

  if (result) {
    if (now - result.at > RESTART_FRESH_MS) {
      clearRestartFiles(paths.ticketPath, paths.resultPath);
      return false;
    }
    const cardMessageId = ticket?.cardMessageId;
    clearRestartFiles(paths.ticketPath, paths.resultPath);
    if (!cardMessageId) return false;
    const card = result.ok
      ? buildRestartCard({ stage: "done", commit: ticket?.commit, elapsedMs: result.elapsedMs, newPid: result.newPid, at: result.at })
      : buildRestartCard({ stage: "failed", error: result.error || "未知错误", at: result.at });
    try {
      await transport.updateCard(cardMessageId, card);
      debugLog("feishu.restart.ack_sent", { ok: result.ok, cardMessageId });
      return true;
    } catch (error) {
      debugLog("feishu.restart.ack_failed", { error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  if (!ticket) return false;
  if (now - ticket.startedAt > RESTART_FRESH_MS) {
    clearRestartFiles(paths.ticketPath, paths.resultPath);
    return false;
  }
  // 老进程还活着 = 重启没真正发生（worker 卡住/老进程没退），别抢先改卡
  // 票据里的 oldPid 等于自己 = 本进程就是发起方，重启尚未发生，更不能改卡
  if (ticket.oldPid === process.pid) return false;
  if (isProcessAlive(ticket.oldPid)) return false;
  const cardMessageId = ticket.cardMessageId;
  clearRestartFiles(paths.ticketPath, paths.resultPath);
  if (!cardMessageId) return false;
  try {
    await transport.updateCard(cardMessageId, buildRestartCard({ stage: "unknown", at: now }));
    return true;
  } catch {
    return false;
  }
}
