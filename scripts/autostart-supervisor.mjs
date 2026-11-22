#!/usr/bin/env node
/**
 * 开机自启巡检 supervisor（纯 .mjs）。
 *
 * 为什么不用 TS：launchd 直接 exec 本文件，进程里没有 Pi 的 TS 运行时保证；
 * 这里只依赖 node 本体（与 `scripts/restart-worker.mjs` 同一取舍）。
 *
 * 与 `src/feishu/autostart.ts` 的分工：
 * - TS 侧：注册表 / plist / 开关（`/feishu autostart on|off`）；
 * - 本文件：只读注册表，按网关锁判断每个实例的 daemon 是否活着，死了就按 daemon-spec 的形状重拉。
 *
 * daemon 启动形状必须与 `src/feishu/daemon-spec.ts` 的 `daemonCommand()` 完全一致 ——
 * 不一致会让 `looksLikeFeishuDaemon()` 认不出新进程，残留进程回收会把重启后的实例当野进程清掉。
 * `test/autostart.test.ts` 有一条用例专门对账两边的命令字符串。
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_INTERVAL_MS = 20_000;
/** 心跳在这段时间内算活着（daemon 每 5s 写一次）。 */
const HEARTBEAT_FRESH_MS = 120_000;
/** 刚抢到锁、还没连上飞书的宽限时间（Pi 冷启动可能很慢）。 */
const STARTING_GRACE_MS = 600_000;
/** 拉起后至少等这么久再判断「是不是没起来」，避免 pi 冷启动期间被反复重拉。 */
const SPAWN_GRACE_MS = 90_000;
const MAX_BACKOFF_MS = 300_000;
const GATEWAY_LOCK_PREFIX = "ax-feishu-bridge.gateway.";
const LEGACY_LOCK_KEY = "pi-feishu-lark.feishu-gateway";
const INSTANCE_DIR_PREFIX = "feishu-";
const INSTANCE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;

const DEFAULTS = {
  registryPath: join(homedir(), ".pi", "agent", "feishu-autostart.json"),
  locksPath: join(homedir(), ".pi", "agent", "locks.json"),
  logPath: join(homedir(), ".pi", "agent", "feishu-autostart.log"),
  pidPath: join(homedir(), ".pi", "agent", "feishu-autostart.supervisor.pid"),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function readJsonSafe(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function gatewayKeyFor(appId) {
  return appId ? `${GATEWAY_LOCK_PREFIX}${appId}` : LEGACY_LOCK_KEY;
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** 与 gateway-lock.ts 的 isStale 保持同一口径，另外给「刚启动」一个较长宽限。 */
export function ownerAlive(owner, now = Date.now()) {
  if (!owner || typeof owner !== "object") return false;
  if (!pidAlive(owner.pid)) return false;
  const heartbeat = Date.parse(owner.heartbeatAt || "");
  if (Number.isFinite(heartbeat) && now - heartbeat <= HEARTBEAT_FRESH_MS) return true;
  const started = Date.parse(owner.startedAt || "");
  return owner.status === "starting" && Number.isFinite(started) && now - started <= STARTING_GRACE_MS;
}

/** 扫描一个工作区下的实例目录（default 是 `.pi/feishu`，其余是 `.pi/feishu-<name>`）。 */
export function scanInstanceDirs(workspace) {
  const piDir = join(workspace, ".pi");
  const found = [];
  const defaultDir = join(piDir, "feishu");
  if (existsSync(join(defaultDir, "config.pi.json"))) found.push({ name: "default", dir: defaultDir });
  let entries = [];
  try {
    entries = readdirSync(piDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!entry.name.startsWith(INSTANCE_DIR_PREFIX)) continue;
    const name = entry.name.slice(INSTANCE_DIR_PREFIX.length);
    if (!INSTANCE_NAME_PATTERN.test(name)) continue;
    const dir = join(piDir, entry.name);
    if (existsSync(join(dir, "config.pi.json"))) found.push({ name, dir });
  }
  return found;
}

/** 与 `src/feishu/daemon-spec.ts` 的 quoteShell 同形：单引号转义。 */
export function quoteShell(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function buildDaemonCommand(piBin, extensionPath) {
  // 与 `src/feishu/daemon-spec.ts` 的 daemonCommand 逐字一致：参数也要过 quoteShell，
  // 否则看起来等价、实际字符串不同，对账测试与 looksLikeFeishuDaemon 的匹配都失去意义。
  const args = ["--mode", "rpc", "-e", extensionPath];
  return `tail -f /dev/null | exec ${quoteShell(piBin)} ${args.map(quoteShell).join(" ")}`;
}

/**
 * 计算一轮要拉起哪些实例（纯函数，便于测试）。
 * `reason`：
 * - `dead`：没有活着的 owner（或锁已陈旧）→ 需要拉起；
 * - `owner-elsewhere`：同一 appId 被别的工作区持有 → 不抢（抢了也会让位，只会刷日志）；
 * - `starting`：owner 活着且仍在宽限期。
 */
export function planTick(registry, locks, now = Date.now()) {
  const actions = [];
  for (const entry of Object.values(registry?.entries ?? {})) {
    if (!entry?.workspace || !entry?.piBin || !entry?.extensionPath) continue;
    const instances = scanInstanceDirs(entry.workspace);
    if (instances.length === 0) {
      actions.push({ workspace: entry.workspace, instance: "-", dir: "", appId: "", reason: "no-instance" });
      continue;
    }
    for (const instance of instances) {
      const cfg = readJsonSafe(join(instance.dir, "config.pi.json"), undefined);
      if (!cfg?.appId || !cfg?.appSecret) continue;
      // 实例级开关：`autoStart: false` 表示这个机器人不参与开机自启
      if (cfg.autoStart === false) continue;
      const owner = locks?.[gatewayKeyFor(cfg.appId)];
      if (ownerAlive(owner, now)) {
        // owner.cwd 是 daemon 的工作区根（不是实例目录）：同一 appId 被别的工作区持有时不抢
        const ownerCwd = typeof owner.cwd === "string" ? resolve(owner.cwd) : "";
        const reason = ownerCwd && ownerCwd !== resolve(entry.workspace) ? "owner-elsewhere" : "starting";
        actions.push({ workspace: entry.workspace, instance: instance.name, dir: instance.dir, appId: cfg.appId, reason });
        continue;
      }
      actions.push({ workspace: entry.workspace, instance: instance.name, dir: instance.dir, appId: cfg.appId, reason: "dead" });
    }
  }
  return actions;
}

function appendLog(path, line) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${new Date().toISOString()} ${line}\n`, { flag: "a" });
  } catch {
    // 日志写不进去不能让巡检停下
  }
}

function readRegistry(path) {
  const parsed = readJsonSafe(path, { version: 1, entries: {} });
  if (!parsed || typeof parsed !== "object") return { version: 1, entries: {} };
  return { version: 1, entries: parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {} };
}

function readLocks(path) {
  const parsed = readJsonSafe(path, {});
  return parsed && typeof parsed === "object" ? parsed : {};
}

function spawnDaemon(entry, action, logPath) {
  const command = buildDaemonCommand(entry.piBin, entry.extensionPath);
  const nodeBinDir = dirname(process.execPath);
  const logFd = openSync(logPath, "a");
  try {
    const child = spawn("/bin/bash", ["-lc", command], {
      detached: true,
      cwd: entry.workspace,
      env: {
        ...process.env,
        // pi 的入口 shebang 是 `/usr/bin/env node`：launchd 的 PATH 只有 /usr/bin:/bin，
        // 必须把 supervisor 自己的 node 目录垫进去，否则 daemon 直接 exec format / not found。
        PATH: `${nodeBinDir}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"}`,
        PI_FEISHU_DAEMON: "1",
        FEISHU_DATA_DIR: action.dir,
      },
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    return child.pid;
  } finally {
    closeSync(logFd);
  }
}

export function parseArgs(argv) {
  const options = { watch: false, once: false, dryRun: false, intervalMs: DEFAULT_INTERVAL_MS, ...DEFAULTS };
  for (const arg of argv) {
    if (arg === "--watch") options.watch = true;
    else if (arg === "--once") options.once = true;
    else if (arg === "--dry-run" || arg === "--dryRun") options.dryRun = true;
    else if (arg.startsWith("--interval=")) {
      const value = Number(arg.slice("--interval=".length));
      if (Number.isFinite(value) && value >= 1000) options.intervalMs = value;
    } else if (arg.startsWith("--registry=")) options.registryPath = arg.slice("--registry=".length);
    else if (arg.startsWith("--locks=")) options.locksPath = arg.slice("--locks=".length);
    else if (arg.startsWith("--log=")) options.logPath = arg.slice("--log=".length);
  }
  if (!options.watch && !options.once) options.watch = true;
  return options;
}

/**
 * 单实例保护：launchd 只有一个，但手动 `--watch` 可能并发起第二份（会双拉 daemon）。
 *
 * 注意 `launchctl kickstart -k` 是「先 SIGTERM 旧进程、立刻起新进程」：新进程读到的 pid
 * 往往还活着（旧进程在 1s 分片睡眠里收尾）。这里最多等 5s 让它退出，等不到才放弃 ——
 * 直接判「已有人在跑」会让 kickstart 后的 supervisor 永久缺失（退出码 0，launchd 不再拉起）。
 */
async function acquirePidLock(path) {
  const existing = readJsonSafe(path, undefined);
  if (existing?.pid && existing.pid !== process.pid && pidAlive(existing.pid)) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && pidAlive(existing.pid)) await sleep(250);
    if (pidAlive(existing.pid)) return false;
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * 跑一轮巡检。返回本轮动作（`--dry-run` 时也返回同一份计划，便于断言）。
 * `attempts` 是跨轮状态：记录上次拉起的时刻与失败次数。
 */
export function runTick(options, attempts = new Map(), now = Date.now()) {
  const registry = readRegistry(options.registryPath);
  const locks = readLocks(options.locksPath);
  const plan = planTick(registry, locks, now);
  const spawned = [];
  const skipped = [];

  for (const action of plan) {
    if (action.reason !== "dead") {
      skipped.push(action);
      continue;
    }
    const entry = registry.entries[action.workspace];
    const previous = attempts.get(action.dir);
    if (previous) {
      const backoff = Math.min(MAX_BACKOFF_MS, SPAWN_GRACE_MS * 2 ** previous.failures);
      if (now - previous.lastSpawnAt < backoff) {
        skipped.push({ ...action, reason: "backoff", retryInMs: backoff - (now - previous.lastSpawnAt) });
        continue;
      }
      previous.failures += 1;
      previous.lastSpawnAt = now;
    } else {
      attempts.set(action.dir, { lastSpawnAt: now, failures: 0 });
    }

    if (options.dryRun) {
      spawned.push({ ...action, dryRun: true });
      continue;
    }
    try {
      const pid = spawnDaemon(entry, action, options.logPath);
      spawned.push({ ...action, pid });
      appendLog(options.logPath, `spawn ${action.workspace} ${action.instance} pid=${pid} dir=${action.dir}`);
    } catch (error) {
      spawned.push({ ...action, error: error instanceof Error ? error.message : String(error) });
      appendLog(options.logPath, `spawn-failed ${action.workspace} ${action.instance} ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { ts: new Date(now).toISOString(), spawned, skipped };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.dryRun && !options.once && !(await acquirePidLock(options.pidPath))) {
    console.error("[feishu-autostart] 已有 supervisor 在跑，本进程退出");
    return;
  }
  appendLog(options.logPath, `supervisor start pid=${process.pid} mode=${options.dryRun ? "dry-run" : options.once ? "once" : "watch"}`);
  const attempts = new Map();
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  do {
    const result = runTick(options, attempts);
    if (options.dryRun || options.once) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.spawned.length || result.skipped.some((a) => a.reason === "backoff")) {
      appendLog(options.logPath, `tick spawned=${result.spawned.length} skipped=${result.skipped.length}`);
    }
    if (options.once || options.dryRun) break;
    // 分片睡眠：收到 SIGTERM 后最多 1s 内退出（launchd bootout 时不必等满 20s）
    const deadline = Date.now() + options.intervalMs;
    while (!stopping && Date.now() < deadline) await sleep(Math.min(1000, deadline - Date.now()));
  } while (!stopping);

  appendLog(options.logPath, `supervisor stop pid=${process.pid}`);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error("[feishu-autostart] supervisor 异常退出：", error);
    process.exit(1);
  });
}

export { DEFAULTS };
