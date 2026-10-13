/**
 * 多开时的进程回收隔离（真进程，不 mock）：
 *
 * 残留 daemon 回收 `reapDetachedDaemonProcesses()` 只能按命令行里的 `feishu/index.ts`
 * 广谱匹配 —— 各工作区共用同一份插件源码，子串匹配分不出实例归属。
 * 因此「有主」的判定必须走网关锁：被任何一把锁认领的 pid（及其后代）都不能回收。
 *
 * 不修这个缺口，在任一工作区敲 `/feishu restart` 会把另一个工作区的 daemon 一起 SIGTERM，
 * 而且那边是被硬杀、锁不走 release，要等 30s stale 才有人能接管。
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
 * 子进程探针：造两个「命令行长得像 daemon」的真进程（一个写进网关锁 = 别的实例，
 * 一个无主 = 残留空壳），跑一次回收，只报告两者是否还活着。
 * 锁必须落在隔离目录（HOME / DSH_HOME 都指向临时目录），否则会动到本机真实 locks.json。
 */
const PROBE = `
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reapDetachedDaemonProcesses } from "./src/adapters/pi/index.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// 命令行带齐 daemon 的全部特征：--mode rpc / --no-extensions / --no-builtin-tools / feishu/index.ts
const fakeDaemon = () => spawn("bash", [
  "-c", "while :; do sleep 1; done", "fake-daemon",
  "--mode", "rpc", "--no-extensions", "--no-builtin-tools",
  "-e", "/tmp/fake/.pi/extensions/feishu/index.ts",
], { stdio: "ignore" });

(async () => {
  const owned = fakeDaemon();
  const orphan = fakeDaemon();
  await sleep(400);

  const dshHome = process.env.DSH_HOME;
  const locksPath = join(dshHome, "locks.json");
  mkdirSync(dshHome, { recursive: true });
  writeFileSync(locksPath, JSON.stringify({
    "ax-feishu-bridge.gateway.app-bot-a": {
      key: "ax-feishu-bridge.gateway.app-bot-a",
      pid: owned.pid,
      token: "token-a",
      cwd: "/tmp/ws-a",
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      status: "connected",
    },
    // 无关插件的锁：不该影响判断，也不该被当成 daemon 认领
    "some-other-plugin.lock": { pid: process.pid },
  }, null, 2));

  reapDetachedDaemonProcesses();
  await sleep(300);

  console.log(JSON.stringify({
    locksPath,
    ownedAlive: alive(owned.pid),
    orphanAlive: alive(orphan.pid),
  }));

  try { owned.kill("SIGKILL"); } catch {}
  try { orphan.kill("SIGKILL"); } catch {}
  process.exit(0);
})();
`;

test("多开：被网关锁认领的 daemon 不被回收，无主空壳才被回收", () => {
  const home = mkdtempSync(join(tmpdir(), "feishu-reap-test-"));
  const dshHome = join(home, ".dsh");
  try {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "-e", PROBE], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: home, DSH_HOME: dshHome },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `子进程应正常退出：${result.stderr}`);
    const out = JSON.parse(result.stdout.trim().split("\n").pop() as string);

    // 先确认锁真的落在隔离目录里（否则这条用例会去动本机真实 locks.json）
    assert.ok(out.locksPath.startsWith(home), `锁文件应在隔离目录，实际 ${out.locksPath}`);
    assert.equal(out.ownedAlive, true, "被网关锁认领的 daemon（另一个实例）不该被杀");
    assert.equal(out.orphanAlive, false, "无主残留空壳应被回收");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
