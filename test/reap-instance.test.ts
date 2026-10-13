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
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 子进程探针：按生产形状造两个「三进程 daemon」（启动壳 bash + tail + pi 真身），
 * 一个把真身 pid 写进网关锁（= 别的实例），一个无主（= 残留空壳），跑一次回收后
 * 报告两边三个进程各自是否还活着。
 * 锁必须落在隔离目录（HOME / DSH_HOME 都指向临时目录），否则会动到本机真实 locks.json。
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

// 生产形状：bash -lc 'tail -f /dev/null | exec pi --mode rpc --no-extensions ... -e .../feishu/index.ts'
const LAUNCH = [
  "tail -f /dev/null",
  "| exec bash -c 'while :; do sleep 1; done' 'fake-pi'",
  "'--mode' 'rpc' '--no-extensions' '--no-builtin-tools'",
  "'-e' '/tmp/fake/.pi/extensions/feishu/index.ts'",
].join(" ");

const fakeDaemon = () => spawn("bash", ["-lc", LAUNCH], { stdio: "ignore" });

function listProcesses() {
  const out = spawnSync("ps", ["-wwaxo", "pid=,ppid=,command="], { encoding: "utf8" }).stdout;
  return out
    .split("\\n")
    .map((line) => line.trim().match(/^(\\d+)\\s+(\\d+)\\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
}

/** 从启动壳 pid 认领它下面那两个孩子：tail（喂 stdin）与 pi 真身。 */
function shapeOf(wrapperPid) {
  const kids = listProcesses().filter((proc) => proc.ppid === wrapperPid);
  return {
    wrapper: wrapperPid,
    tail: kids.find((proc) => proc.command.includes("tail -f /dev/null"))?.pid,
    real: kids.find((proc) => proc.command.includes("fake-pi"))?.pid,
  };
}

const report = (s) => ({ wrapper: alive(s.wrapper), tail: alive(s.tail), real: alive(s.real) });
const cleanup = (s) => {
  for (const pid of [s.real, s.tail, s.wrapper]) {
    try { if (pid) process.kill(pid, "SIGKILL"); } catch {}
  }
};

(async () => {
  const ownedWrapper = fakeDaemon();
  const orphanWrapper = fakeDaemon();
  await sleep(600);

  const owned = shapeOf(ownedWrapper.pid);
  const orphan = shapeOf(orphanWrapper.pid);

  const dshHome = process.env.DSH_HOME;
  const locksPath = join(dshHome, "locks.json");
  mkdirSync(dshHome, { recursive: true });
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

  reapDetachedDaemonProcesses();
  await sleep(500);

  console.log(JSON.stringify({
    locksPath,
    owned: { ...owned, ...report(owned) },
    orphan: { ...orphan, ...report(orphan) },
  }));

  cleanup(owned);
  cleanup(orphan);
  process.exit(0);
})();
`;

test("多开：被网关锁认领的 daemon（含启动壳与 tail）不被回收，无主空壳才被回收", () => {
  const home = mkdtempSync(join(tmpdir(), "feishu-reap-test-"));
  const dshHome = join(home, ".dsh");
  try {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "-e", PROBE], {
      cwd: REPO_ROOT,
      // FEISHU_DATA_DIR 指到临时目录：探针里的 ensureRoot()/debugLog() 不该往仓库或真实 HOME 写东西
      env: { ...process.env, HOME: home, DSH_HOME: dshHome, FEISHU_DATA_DIR: join(home, "feishu-data") },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `子进程应正常退出：${result.stderr}`);
    const out = JSON.parse(result.stdout.trim().split("\n").pop() as string);

    // 先确认锁真的落在隔离目录里（否则这条用例会去动本机真实 locks.json）
    assert.ok(out.locksPath.startsWith(home), `锁文件应在隔离目录，实际 ${out.locksPath}`);

    // 探针自身要先认出三进程结构，否则下面的断言等于没测
    assert.ok(out.owned.real && out.owned.tail, `探针应认出别的实例的 tail/真身：${JSON.stringify(out.owned)}`);

    assert.equal(out.owned.real, true, "被网关锁认领的 daemon 真身（另一个实例）不该被杀");
    assert.equal(out.owned.tail, true, "它的 tail 不该被杀（否则那个 daemon 的 stdin 会 EOF）");
    assert.equal(out.owned.wrapper, true, "它的启动壳不该被回收");

    assert.equal(out.orphan.wrapper, false, "无主残留空壳（启动壳）应被回收");
    assert.equal(out.orphan.real, false, "无主残留空壳的真身应被回收");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
