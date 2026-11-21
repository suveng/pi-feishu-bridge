/**
 * 连接锁按机器人凭证（appId）区分的测试：
 * - 不同机器人：各拿各的钥匙，可并行获取
 * - 同一机器人、不同进程：互斥，后来的拿不到
 * - 同一机器人、同一进程（扩展被重复加载出两份副本）：复用同一把锁，不得判成 busy
 *   2026-11-21 事故回归：同 pid 自锁被当成「别人占着」→ daemon 启动分支 process.exit(0)
 *   → autoStart 拉起一个死一个 → 飞书永久断线。
 * - 释放后同机器人可再次获取
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { acquireGatewayLock } from "../src/feishu/gateway-lock.ts";

/** 每个用例独占一个临时锁文件，绝不碰真实的 ~/.pi/agent/locks.json。 */
async function withTempLocks(fn: (locksPath: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "feishu-lock-test-"));
  const previous = process.env.FEISHU_LOCKS_PATH;
  const locksPath = join(dir, "agent", "locks.json");
  process.env.FEISHU_LOCKS_PATH = locksPath;
  try {
    await fn(locksPath);
  } finally {
    if (previous === undefined) delete process.env.FEISHU_LOCKS_PATH;
    else process.env.FEISHU_LOCKS_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("gateway lock is per-appId: different bots can hold locks in parallel", async () => {
  await withTempLocks(async () => {
    const botA = await acquireGatewayLock("/tmp/ws", false, "app-bot-a");
    assert.equal(botA.status, "acquired");
    const botB = await acquireGatewayLock("/tmp/ws", false, "app-bot-b");
    assert.equal(botB.status, "acquired", "different bot should get its own lock");

    await botA.handle.release();
    await botB.handle.release();
  });
});

test("gateway lock: 同一进程内复用同一把锁（重复加载扩展副本不再自杀）", async () => {
  await withTempLocks(async (locksPath) => {
    const first = await acquireGatewayLock("/tmp/ws", false, "app-bot-dup");
    assert.equal(first.status, "acquired");

    const second = await acquireGatewayLock("/tmp/ws", false, "app-bot-dup");
    assert.equal(second.status, "acquired", "same pid must reuse its own lock, not be treated as busy");
    assert.equal(
      second.handle.owner.token,
      first.handle.owner.token,
      "reuse must keep the same token and owner, otherwise the first copy would see lock_lost",
    );
    assert.equal(second.handle.owner.pid, process.pid);

    // 复用不重写锁文件：owner 记录里仍是第一份副本写入的时间戳
    const { readFileSync } = await import("node:fs");
    const raw = JSON.parse(readFileSync(locksPath, "utf8")) as Record<string, { pid: number; token: string }>;
    assert.equal(raw["ax-feishu-bridge.gateway.app-bot-dup"].token, first.handle.owner.token);

    await first.handle.release();
    await second.handle.release();
  });
});

test("gateway lock: 其它进程持有时仍然 busy（含无权发信号的 EPERM 进程）", async () => {
  await withTempLocks(async (locksPath) => {
    const key = "ax-feishu-bridge.gateway.app-bot-foreign";
    const owner = {
      key,
      // pid 1 一定存活；当前用户无权给它发信号（EPERM），早期实现会当成死进程把锁抢走
      pid: 1,
      token: "foreign-token",
      cwd: "/tmp/other-ws",
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      status: "connected",
    };
    mkdirSync(dirname(locksPath), { recursive: true });
    writeFileSync(locksPath, `${JSON.stringify({ [key]: owner }, null, 2)}\n`, "utf8");

    const result = await acquireGatewayLock("/tmp/ws", false, "app-bot-foreign");
    assert.equal(result.status, "busy", "another live process must still block us");
    if (result.status === "busy") assert.equal(result.owner.pid, 1);
  });
});

test("gateway lock: 释放后同一机器人可再次获取", async () => {
  await withTempLocks(async () => {
    const first = await acquireGatewayLock("/tmp/ws", false, "app-bot-a");
    assert.equal(first.status, "acquired");
    await first.handle.release();
    const again = await acquireGatewayLock("/tmp/ws", false, "app-bot-a");
    assert.equal(again.status, "acquired", "after release the same bot can connect again");
    await again.handle.release();
  });
});
