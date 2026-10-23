#!/usr/bin/env node
/**
 * 重启 worker：`node scripts/restart-worker.mjs <ticketPath>`
 *
 * 独立于桥接进程存在的原因——老进程必须死，新进程必须由别人拉起，
 * 而且「新进程是否真的拿到网关锁」只能由第三方观察。
 *
 * 约定（restart.ts 写票据，这里读票据）：
 *   ticket.oldPid        老 daemon 的 pid（先等它自己退，超时才 SIGTERM/SIGKILL）
 *   ticket.piBin/args    新 daemon 的启动形状（与 startDaemon 完全一致）
 *   ticket.lockPath      网关锁文件，出现在里面的 pid 才算真正接管
 *   ticket.resultPath    结果落点，新 daemon 启动时读它来回改卡片
 *
 * 这个文件是纯 .mjs：不能 import TS（daemon 由 `--experimental-strip-types` 跑的 TS，
 * worker 只想依赖 node 本体，避免启动失败把重启卡死）。
 */
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

const ticketPath = process.argv[2];
if (!ticketPath) {
  console.error("[restart-worker] 缺少票据路径");
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function writeResult(path, result) {
  const payload = JSON.stringify(result, null, 2);
  try {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, payload, "utf8");
    renameSync(tmp, path);
    return true;
  } catch (error) {
    console.error(`[restart-worker] 写结果失败：${error instanceof Error ? error.message : String(error)}`);
    try {
      writeFileSync(path, payload, "utf8");
      return true;
    } catch {
      return false;
    }
  }
}

function isAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function signal(pid, name) {
  try {
    process.kill(pid, name);
    return true;
  } catch {
    return false;
  }
}

function quoteShell(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * 锁文件里落到「我们拉起的那个进程」才算接管。
 *
 * 注意 POSIX 的启动形状是 `bash -lc 'tail -f /dev/null | exec pi …'`：
 * `spawn()` 拿到的是**外层 bash** 的 pid，真正的 daemon 是被 exec 掉的管道子进程，
 * 所以除了 pid 相等，还要认「父进程是我们」这一种（实测 bash pid 与 daemon pid 差几号）。
 */
function ownsLock(lockPath, launcherPid) {
  const locks = readJson(lockPath);
  if (!locks || typeof locks !== "object") return undefined;
  for (const entry of Object.values(locks)) {
    if (!entry || typeof entry.pid !== "number") continue;
    if (entry.pid === launcherPid) return entry.pid;
    if (parentPidOf(entry.pid) === launcherPid && isAlive(entry.pid)) return entry.pid;
  }
  return undefined;
}

function psField(pid, field) {
  if (process.platform === "win32") return undefined;
  const res = spawnSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8" });
  const value = res.stdout?.trim();
  return value || undefined;
}

/**
 * 收掉老 daemon 的启动壳 `bash -lc 'tail -f /dev/null | exec pi …'`。
 *
 * 老 daemon 自己退出时只 SIGTERM 了父 bash（旧版本行为），里面的 `tail -f /dev/null`
 * 会被 reparent 到 init 永久挂着，每重启一次漏一个。worker 是新代码、每次现读，
 * 所以在这里兜住：老进程死后按**进程组**整组收（detached spawn 的组里只有 bash+tail）。
 */
function cleanupLauncher(launcherPid) {
  if (!launcherPid || launcherPid <= 1) return;
  try {
    const command = psField(launcherPid, "command");
    if (!command || !command.includes("tail -f /dev/null")) return;
    const pgid = Number(psField(launcherPid, "pgid"));
    if (Number.isFinite(pgid) && pgid === launcherPid) {
      process.kill(-pgid, "SIGTERM");
    } else {
      process.kill(launcherPid, "SIGTERM");
    }
    console.log(`[restart-worker] 已收掉老启动壳 ${launcherPid}（含 tail）`);
  } catch (error) {
    console.error(`[restart-worker] 收老启动壳失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function parentPidOf(pid) {
  if (process.platform === "win32") return undefined;
  const res = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
  const ppid = Number(res.stdout?.trim());
  return Number.isFinite(ppid) && ppid > 0 ? ppid : undefined;
}

function spawnDaemon(ticket) {
  const logFd = openSync(ticket.logPath, "a");
  if (process.platform === "win32") {
    const npmPrefix = process.env.APPDATA ? `${process.env.APPDATA}\\npm` : `${process.env.USERPROFILE}\\AppData\\Roaming\\npm`;
    const piCliEntry = process.env.PI_CLI_ENTRY || `${npmPrefix}\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js`;
    const child = spawn("node", [piCliEntry, ...ticket.args], {
      detached: true,
      cwd: ticket.cwd,
      env: { ...process.env, PI_FEISHU_DAEMON: "1" },
      stdio: ["pipe", logFd, logFd],
    });
    if (child.stdin) child.stdin.resume();
    closeSync(logFd);
    return child;
  }
  const command = `tail -f /dev/null | exec ${quoteShell(ticket.piBin)} ${ticket.args.map(quoteShell).join(" ")}`;
  const child = spawn("bash", ["-lc", command], {
    detached: true,
    cwd: ticket.cwd,
    env: { ...process.env, PI_FEISHU_DAEMON: "1" },
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  return child;
}

async function main() {
  const ticket = readJson(ticketPath);
  if (!ticket || ticket.version !== 1) {
    console.error(`[restart-worker] 票据不可读：${ticketPath}`);
    return;
  }
  const startedAt = Number(ticket.startedAt) || Date.now();
  const resultPath = ticket.resultPath;
  const started = Date.now();
  const finish = (result) => writeResult(resultPath, { version: 1, at: Date.now(), elapsedMs: Date.now() - started, ...result });

  console.log(`[restart-worker] 票据 ${ticketPath} · 老 pid ${ticket.oldPid} · cwd ${ticket.cwd}`);

  // 1) 等老进程自己退（它发完「重启中」卡片、拉完我们就 return，正常 1s 内就没了）
  // 票据里的 launcherPid 是老 daemon 退出前记下的（最可靠）；老版本票据没有这个字段，
  // 退回现查 ppid（只有在老 daemon 还没退时才有意义）。
  const oldLauncherPid = ticket.launcherPid || parentPidOf(ticket.oldPid);
  const exitDeadline = Date.now() + 15_000;
  while (Date.now() < exitDeadline && isAlive(ticket.oldPid)) {
    if (Date.now() - started > 5_000) signal(ticket.oldPid, "SIGTERM");
    if (Date.now() - started > 10_000) signal(ticket.oldPid, "SIGKILL");
    await sleep(100);
  }
  if (isAlive(ticket.oldPid)) {
    console.error(`[restart-worker] 老进程 ${ticket.oldPid} 杀不掉，放弃重启`);
    finish({ ok: false, error: `老桥接进程（pid ${ticket.oldPid}）无法结束，请在终端用 /feishu restart 重试` });
    return;
  }
  console.log(`[restart-worker] 老进程已退出，耗时 ${Date.now() - started}ms`);
  cleanupLauncher(oldLauncherPid);

  // 2) 按同一 spec 拉新 daemon
  rmSync(ticket.resultPath, { force: true });
  let child;
  try {
    child = spawnDaemon(ticket);
  } catch (error) {
    finish({ ok: false, error: `新桥接进程启动失败：${error instanceof Error ? error.message : String(error)}` });
    return;
  }
  const newPid = child.pid;
  let exited = false;
  child.on("exit", (code, sig) => {
    exited = true;
    console.error(`[restart-worker] 新进程 ${newPid} 退出 code=${code} sig=${sig}`);
  });
  child.unref();
  console.log(`[restart-worker] 新进程 pid ${newPid}，等待网关锁`);

  // 3) 等网关锁落到新 pid（启动重试退避最长约 15s，这里留 45s）
  const lockDeadline = Date.now() + 45_000;
  while (Date.now() < lockDeadline) {
    if (exited) {
      finish({ ok: false, error: `新桥接进程启动后立即退出（pid ${newPid}），详见 ${ticket.logPath}` });
      return;
    }
    const lockPid = ownsLock(ticket.lockPath, newPid);
    if (lockPid) {
      console.log(`[restart-worker] 已接管网关锁（pid ${lockPid}，launcher ${newPid}），耗时 ${Date.now() - started}ms`);
      finish({ ok: true, newPid: lockPid, launcherPid: newPid });
      return;
    }
    await sleep(250);
  }
  finish({ ok: false, error: `新进程 ${newPid} 45s 内未拿到网关锁，详见 ${ticket.logPath}` });
}

main()
  .catch((error) => {
    console.error(`[restart-worker] 未捕获异常：${error instanceof Error ? error.stack || error.message : String(error)}`);
  })
  .finally(() => {
    // 不 await：detached 子进程不受本进程退出影响
    process.exit(0);
  });
