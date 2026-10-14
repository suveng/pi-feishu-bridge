import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { debugLog } from "./debug.ts";

/** 兼容旧版锁（未按 appId 区分时的固定 key）。 */
const LEGACY_LOCK_KEY = "pi-feishu-lark.feishu-gateway";
/** 网关锁 key 前缀：`<前缀><appId>`，一个机器人一把锁。 */
const GATEWAY_LOCK_PREFIX = "ax-feishu-bridge.gateway.";
const PI_AGENT_DIR = join(homedir(), ".pi", "agent");
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_ATTEMPTS = 40;
const HEARTBEAT_MS = 5_000;

/**
 * 锁按机器人凭证（appId）区分：不同机器人各拿各的钥匙，可并行；
 * 同一机器人（误配）仍互斥，避免抢同一个飞书连接。
 */
function lockKeyFor(appId: string | undefined) {
  return appId ? `${GATEWAY_LOCK_PREFIX}${appId}` : LEGACY_LOCK_KEY;
}

/**
 * 锁文件选址：一律在 Pi 的 agent 目录（`~/.pi/agent/locks.json`）。
 * 锁按 appId 全局互斥是护栏：飞书长连接是集群模式、不广播，
 * 同一台机器上多个工作区共用同一个机器人会互相抢连接，所以要放在机器级位置协商。
 */
const LOCKS_PATH = join(PI_AGENT_DIR, "locks.json");

export type GatewayOwner = {
  key: string;
  pid: number;
  token: string;
  cwd: string;
  startedAt: string;
  heartbeatAt: string;
  status: "starting" | "connected" | "disconnected";
};

type LocksFile = Record<string, unknown>;

export type GatewayLockResult =
  | { status: "acquired"; handle: GatewayLockHandle }
  | { status: "busy"; owner: GatewayOwner };

export class GatewayLockHandle {
  private heartbeat: NodeJS.Timeout | undefined;
  private onLost: (() => void | Promise<void>) | undefined;
  readonly owner: GatewayOwner;

  constructor(owner: GatewayOwner) {
    this.owner = owner;
  }

  setOnLost(handler: () => void | Promise<void>) {
    this.onLost = handler;
  }

  startHeartbeat() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      this.update("connected").catch((error) => {
        debugLog("feishu.gateway.heartbeat_error", { error: error instanceof Error ? error.message : String(error) });
      });
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  async update(status: GatewayOwner["status"]) {
    let lostOwnership = false;
    await withLocksFileLock(() => {
      const locks = readLocksFile();
      const current = asGatewayOwner(locks[this.owner.key], this.owner.key);
      if (!current || current.token !== this.owner.token || current.pid !== this.owner.pid) {
        this.stopHeartbeat();
        lostOwnership = true;
        return;
      }
      const next: GatewayOwner = {
        ...current,
        heartbeatAt: new Date().toISOString(),
        status,
      };
      locks[this.owner.key] = next;
      writeLocksFile(locks);
    });
    if (lostOwnership) {
      debugLog("feishu.gateway.lock_lost", { pid: this.owner.pid });
      await this.onLost?.();
    }
  }

  async release() {
    this.stopHeartbeat();
    await withLocksFileLock(() => {
      const locks = readLocksFile();
      const current = asGatewayOwner(locks[this.owner.key], this.owner.key);
      if (current?.token === this.owner.token && current.pid === this.owner.pid) {
        delete locks[this.owner.key];
        writeLocksFile(locks);
        debugLog("feishu.gateway.lock_released", { pid: this.owner.pid });
      }
    });
  }

  private stopHeartbeat() {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
}

export async function acquireGatewayLock(cwd: string, force = false, appId?: string): Promise<GatewayLockResult> {
  const key = lockKeyFor(appId);
  return withLocksFileLock(() => {
    const locks = readLocksFile();
    const existing = asGatewayOwner(locks[key], key);
    if (existing && !force && !isStale(existing)) {
      debugLog("feishu.gateway.lock_busy", {
        ownerPid: existing.pid,
        heartbeatAt: existing.heartbeatAt,
        currentPid: process.pid,
      });
      return { status: "busy", owner: existing };
    }

    const owner: GatewayOwner = {
      key,
      pid: process.pid,
      token: randomToken(),
      cwd,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      status: "starting",
    };
    locks[key] = owner;
    writeLocksFile(locks);
    debugLog("feishu.gateway.lock_acquired", {
      pid: owner.pid,
      cwd,
      replacedPid: existing?.pid,
      force,
    });
    return { status: "acquired", handle: new GatewayLockHandle(owner) };
  });
}

export function readGatewayOwner(appId?: string): GatewayOwner | undefined {
  const key = lockKeyFor(appId);
  const owner = asGatewayOwner(readLocksFile()[key], key);
  return owner && !isStale(owner) ? owner : undefined;
}

/**
 * 列出本机**所有**实例（所有 appId，含 legacy key）当前活着的网关锁 owner pid。
 *
 * 用途：残留 daemon 回收只能按命令行里的 `feishu/index.ts` 广谱匹配 —— 各工作区共用同一份
 * 插件源码，子串匹配分不出实例归属。多开（同机多工作区 + 各自的自建应用）时必须以锁为准：
 * 凡被任何一把网关锁认领的 pid 都不回收，否则重启一个工作区会把另一个工作区一起 SIGTERM。
 */
export function readAllGatewayOwnerPids(): number[] {
  const locks = readLocksFile();
  const pids = new Set<number>();
  for (const [key, value] of Object.entries(locks)) {
    if (key !== LEGACY_LOCK_KEY && !key.startsWith(GATEWAY_LOCK_PREFIX)) continue;
    const owner = asGatewayOwner(value, key);
    // 死 pid 留着没用，还可能已被系统回收给无关进程 —— 只认活着的
    if (owner && isProcessAlive(owner.pid)) pids.add(owner.pid);
  }
  return [...pids];
}

export function gatewayLockPath() {
  return LOCKS_PATH;
}

function asGatewayOwner(value: unknown, expectedKey: string): GatewayOwner | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<GatewayOwner>;
  if (raw.key !== expectedKey) return undefined;
  if (typeof raw.pid !== "number" || typeof raw.token !== "string") return undefined;
  if (typeof raw.cwd !== "string" || typeof raw.startedAt !== "string" || typeof raw.heartbeatAt !== "string") return undefined;
  if (raw.status !== "starting" && raw.status !== "connected" && raw.status !== "disconnected") return undefined;
  return raw as GatewayOwner;
}

function isStale(owner: GatewayOwner) {
  if (!isProcessAlive(owner.pid)) return true;
  const heartbeatAt = Date.parse(owner.heartbeatAt);
  if (!Number.isFinite(heartbeatAt)) return true;
  return Date.now() - heartbeatAt > LOCK_STALE_MS;
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function randomToken() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readLocksFile(): LocksFile {
  try {
    if (!existsSync(LOCKS_PATH)) return {};
    return JSON.parse(readFileSync(LOCKS_PATH, "utf8")) as LocksFile;
  } catch {
    return {};
  }
}

function writeLocksFile(locks: LocksFile) {
  mkdirSync(dirname(LOCKS_PATH), { recursive: true });
  writeFileSync(LOCKS_PATH, `${JSON.stringify(locks, null, 2)}\n`, "utf8");
}

async function withLocksFileLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const lockPath = `${LOCKS_PATH}.lock`;
  mkdirSync(dirname(LOCKS_PATH), { recursive: true });

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    if (tryAcquireFileLock(lockPath)) {
      try {
        return await fn();
      } finally {
        try { rmSync(lockPath, { recursive: true, force: true }); } catch {}
      }
    }
    await sleep(LOCK_RETRY_MS);
  }

  debugLog("feishu.gateway.file_lock_timeout", { lockPath });
  return await fn();
}

function tryAcquireFileLock(lockPath: string) {
  try {
    mkdirSync(lockPath);
    return true;
  } catch {
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age > LOCK_STALE_MS) rmSync(lockPath, { recursive: true, force: true });
    } catch {}
    return false;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
