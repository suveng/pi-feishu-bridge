/**
 * 多开时的进程回收隔离（真进程，不 mock）：
 *
 * 残留 daemon 回收 `reapDetachedDaemonProcesses()` 只能按命令行里的 `feishu/index.ts`
 * 广谱匹配 —— 各工作区共用同一份插件源码，子串匹配分不出实例归属。
 * 因此「有主」的判定必须走网关锁，而且要连 daemon 的**启动壳**一起保：
 * 壳是 `bash -lc 'tail -f /dev/null | exec pi ...'`，tail 持着 pi stdin 的写端，
 * 壳被回收会连带 tail 一起死 → 那个 daemon 的 stdin 直接 EOF。
 *
 * 不修这个缺口，在任一工作区敲 `/feishu restart` 会把另一个工作区的 daemon 一起打掉，
 * 而且那边是硬杀、锁不走 release，要等 30s stale 才有人能接管。
 *
 * 另一半（2026-10-14 事故）：回收**必须带扩展入口路径**，不能回退到 `feishu/index.ts`
 * 这种全机广谱匹配 —— 否则本套件在隔离 HOME 里跑 reap 时，真实 daemon 不在那把临时锁里，
 * 一次 `npm test` 会把整机所有工作区的 daemon 全 SIGTERM（实际发生过：两边桥接同时掉线）。
 * 所以探针额外造一个「别的实例入口」的 daemon，验证它既不被扫到也不被误杀。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 子进程探针：按生产形状造两个「三进程 daemon」（启动壳 bash + tail + pi 真身），
 * 一个把真身 pid 写进网关锁（= 别的实例），一个无主（= 残留空壳），跑一次回收后
 * 报告两边三个进程各自是否还活着。
 * 锁必须落在隔离目录（HOME 指向临时目录），否则会动到本机真实 locks.json。
 */
const PROBE = `
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reapDetachedDaemonProcesses } from "./src/adapters/pi/index.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// 生产形状：bash -lc 'tail -f /dev/null | exec pi --mode rpc -e .../feishu/index.ts'（2026-11-13 起不再带 --no-*）
const OWN_EXT = "/tmp/fake/.pi/extensions/feishu/index.ts";
// 别的实例（另一个工作区）的入口：本实例的回收不该看它一眼
const FOREIGN_EXT = "/tmp/fake-other/.pi/extensions/feishu/index.ts";

const LAUNCH = (ext) => [
  "tail -f /dev/null",
  "| exec bash -c 'while :; do sleep 1; done' 'fake-pi'",
  "'--mode' 'rpc'",
  "'-e' '" + ext + "'",
].join(" ");

const fakeDaemon = (ext) => spawn("bash", ["-lc", LAUNCH(ext)], { stdio: "ignore" });

/**
 * 生产里 launcher -> 启动壳 -> (tail, pi) 可能不止一层（Popen、重启脚本、终端各自一层）。
 * 这里给「有主」的那个再套一层 launcher，且 launcher 的命令行里也带着同一串启动文本
 * （同样会被根判据命中）：只保「直接父进程」的旧实现会把这一层 SIGTERM 掉，
 * tail 随即变孤儿，管道写端一关 -> pi 的 stdin EOF -> 桥接掉线。
 * 末尾的 "; :" 是为了不让 bash 把唯一一条命令 exec 优化掉，保住两层结构。
 */
const spawnNested = (ext) => spawn("bash", ["-c", "bash -lc " + JSON.stringify(LAUNCH(ext)) + " ; :"], { stdio: "ignore" });

function listProcesses() {
  const out = spawnSync("ps", ["-wwaxo", "pid=,ppid=,command="], { encoding: "utf8" }).stdout;
  return out
    .split("\\n")
    .map((line) => line.trim().match(/^(\\d+)\\s+(\\d+)\\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
}

/**
 * 启动链的层数随平台/容器变：macOS 的 bash 把管道两段挂在启动壳的**直接**子进程上，
 * Linux（GitHub Actions 的 ubuntu-latest）上会再多套一层子 shell，tail / pi 真身就落到孙辈。
 * 2026-11-10 只认一层时 Linux 上认不出 -> lock 里写进 undefined -> 回收器 keep 集合为空 ->
 * 连「有主」的 daemon 一起被杀，CI 报「探针应认出别的实例的 tail/真身」。故按后代找，不再只认一层。
 */
function childrenMap() {
  const map = new Map();
  for (const proc of listProcesses()) {
    const arr = map.get(proc.ppid) || [];
    arr.push(proc);
    map.set(proc.ppid, arr);
  }
  return map;
}

/** 广度优先取后代（默认最多四层，足够覆盖 启动壳 -> 子 shell -> 管道两段）。 */
function descendantsOf(rootPid, maxDepth = 4) {
  const byParent = childrenMap();
  const out = [];
  let level = [rootPid];
  for (let depth = 0; depth < maxDepth && level.length; depth += 1) {
    const next = [];
    for (const pid of level) {
      for (const kid of byParent.get(pid) || []) {
        out.push(kid);
        next.push(kid.pid);
      }
    }
    level = next;
  }
  return out;
}

/** 从启动壳 pid 认领它下面那两个进程：tail（喂 stdin）与 pi 真身（按后代找，见上）。 */
function shapeOf(wrapperPid) {
  const kids = descendantsOf(wrapperPid);
  return {
    wrapper: wrapperPid,
    tail: kids.find((proc) => proc.command.includes("tail -f /dev/null"))?.pid,
    real: kids.find((proc) => proc.command.includes("fake-pi"))?.pid,
  };
}

/** 认不出时把「启动壳下面到底有什么」写进断言消息：CI 红一次就能看清形状，不必再猜平台差异。 */
const treeOf = (rootPid) => descendantsOf(rootPid).map((proc) => ({
  pid: proc.pid,
  ppid: proc.ppid,
  command: proc.command.slice(0, 120),
}));

const report = (s) => ({ wrapper: alive(s.wrapper), tail: alive(s.tail), real: alive(s.real) });

/** 复现生产判据：命令行（去引号）里出现 rpc + 喂 stdin 的 tail + 与本实例入口紧邻的 -e。 */
function looksLikeRoot(pid, ext) {
  const proc = listProcesses().find((p) => p.pid === pid);
  if (!proc) return false;
  const normalized = proc.command.replace(/'/g, "");
  return normalized.includes("--mode rpc") && normalized.includes("tail -f /dev/null")
    && normalized.includes("-e " + ext);
}

/** 等启动壳把两个孩子（tail + 真身）都拉起来：strip-types 下固定 600ms 等待不够稳，会漏认。 */
async function waitForShape(wrapperPid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let shape = shapeOf(wrapperPid);
  while ((!shape.tail || !shape.real) && Date.now() < deadline) {
    await sleep(100);
    shape = shapeOf(wrapperPid);
  }
  return shape;
}
const cleanup = (s) => {
  for (const pid of [s.real, s.tail, s.wrapper]) {
    try { if (pid) process.kill(pid, "SIGKILL"); } catch {}
  }
};

/** 等 launcher 把启动壳 fork 出来（拿它的 pid 才能继续认 tail / 真身）。同样按后代找，兼容多套一层的平台。 */
async function waitForChild(parentPid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let child = descendantsOf(parentPid)[0]?.pid;
  while (!child && Date.now() < deadline) {
    await sleep(100);
    child = descendantsOf(parentPid)[0]?.pid;
  }
  return child;
}

(async () => {
  const ownedLauncher = spawnNested(OWN_EXT);
  const ownedWrapperPid = await waitForChild(ownedLauncher.pid);
  const orphanWrapper = fakeDaemon(OWN_EXT);
  const foreignWrapper = fakeDaemon(FOREIGN_EXT);

  const owned = await waitForShape(ownedWrapperPid);
  const orphan = await waitForShape(orphanWrapper.pid);
  const foreign = await waitForShape(foreignWrapper.pid);

  const agentDir = join(process.env.HOME, ".pi", "agent");
  const locksPath = join(agentDir, "locks.json");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(locksPath, JSON.stringify({
    "ax-feishu-bridge.gateway.app-bot-a": {
      key: "ax-feishu-bridge.gateway.app-bot-a",
      pid: owned.real,
      token: "token-a",
      cwd: "/tmp/ws-a",
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      status: "connected",
    },
    // 无关插件的锁：不该被当成 daemon 认领，也不该影响判断
    "some-other-plugin.lock": { pid: process.pid },
  }, null, 2));

  // 【前提】必须在 reap 之前算：被回收掉的进程在 ps 里就查不到了，
  // 断言会变成「launcherIsRoot=false」，把「前提不成立」和「真被误杀」两件事混在一起。
  const launcherIsRootBefore = looksLikeRoot(ownedLauncher.pid, OWN_EXT);
  reapDetachedDaemonProcesses({ extensionPath: OWN_EXT });
  await sleep(500);

  console.log(JSON.stringify({
    locksPath,
    owned: { launcher: alive(ownedLauncher.pid), launcherPid: ownedLauncher.pid, launcherIsRoot: launcherIsRootBefore, ...owned, ...report(owned) },
    orphan: { ...orphan, ...report(orphan) },
    foreign: { ...foreign, ...report(foreign) },
    // 认不出形状时的唯一证据来源：启动壳下面实际挂了哪些进程（含命令行为前 120 字）
    ownedTree: treeOf(ownedWrapperPid),
    orphanTree: treeOf(orphanWrapper.pid),
    foreignTree: treeOf(foreignWrapper.pid),
  }));

  cleanup(owned);
  cleanup(orphan);
  cleanup(foreign);
  try { process.kill(ownedLauncher.pid, "SIGKILL"); } catch {}
  process.exit(0);
})();
`;

test("多开：被网关锁认领的 daemon（含启动壳与 tail）不被回收，无主空壳才被回收", () => {
  const home = mkdtempSync(join(tmpdir(), "feishu-reap-test-"));
  try {
    // 【必须在 spawn 之前建好隔离 HOME 的 ~/.pi/agent】
    // gateway-lock 在 import 时就定下 LOCKS_PATH = `~/.pi/agent/locks.json`；
    // 不先建目录的话，探针写进隔离 HOME 的锁根本不被读到，
    // keep 集合为空 → 连「有主」的 daemon 也会被杀，这条用例在那种克隆里必假红。
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "-e", PROBE], {
      cwd: REPO_ROOT,
      // FEISHU_DATA_DIR 指到临时目录：探针里的 ensureRoot()/debugLog() 不该往仓库或真实 HOME 写东西
      env: { ...process.env, HOME: home, FEISHU_DATA_DIR: join(home, "feishu-data") },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `子进程应正常退出：${result.stderr}`);
    const out = JSON.parse(result.stdout.trim().split("\n").pop() as string);

    // 先确认锁真的落在隔离目录里（否则这条用例会去动本机真实 locks.json）
    assert.ok(out.locksPath.startsWith(home), `锁文件应在隔离目录，实际 ${out.locksPath}`);

    // 探针自身要先认出三进程结构，否则下面的断言等于没测
    assert.ok(out.owned.real && out.owned.tail, `探针应认出别的实例的 tail/真身：${JSON.stringify(out.owned)}；启动壳下实际进程=${JSON.stringify(out.ownedTree)}`);

    assert.equal(out.owned.real, true, "被网关锁认领的 daemon 真身（另一个实例）不该被杀");
    assert.equal(out.owned.tail, true, "它的 tail 不该被杀（否则那个 daemon 的 stdin 会 EOF）");
    assert.equal(out.owned.wrapper, true, "它的启动壳不该被回收");
    // 回归：启动链可能不止一层 —— launcher 的命令行里也带着同一串启动文本，
    // 只保「直接父进程」时它会被回收，tail 变孤儿后 daemon 的 stdin 就 EOF 了（实际发生过）。
    assert.ok(out.owned.launcherIsRoot, "用例前提：launcher 的命令行本身也会被判据命中（否则这条断言无效）");
    assert.equal(out.owned.launcher, true, "启动链上层的 launcher 不该被回收");

    assert.equal(out.orphan.wrapper, false, "无主残留空壳（启动壳）应被回收");
    assert.equal(out.orphan.real, false, "无主残留空壳的真身应被回收");

    // 回归：扫描只作用于本实例入口，别的实例（另一个工作区）的 daemon 即便无锁也不许动
    assert.ok(out.foreign.real && out.foreign.tail, `探针应认出别的实例的 tail/真身：${JSON.stringify(out.foreign)}`);
    assert.equal(out.foreign.real, true, "别的实例入口的 daemon 真身不该被回收");
    assert.equal(out.foreign.tail, true, "别的实例入口的 tail 不该被回收");
    assert.equal(out.foreign.wrapper, true, "别的实例入口的启动壳不该被回收");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
