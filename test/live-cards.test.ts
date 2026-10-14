import test from "node:test";
import assert from "node:assert/strict";
import {
  INTERRUPTED_NOTE,
  createExitHandler,
  finishLiveCards,
  liveCardCount,
  registerLiveCard,
  resetLiveCards,
  unregisterLiveCard,
  type LiveCardSink,
} from "../src/feishu/live-cards.ts";

/** 造一个只记录调用的假卡片 */
function fakeCard(runId: string, behavior?: { hang?: boolean; throw?: boolean }) {
  const calls: { status: string; note?: string }[] = [];
  const card: LiveCardSink = {
    runId,
    async finish(status, note) {
      calls.push({ status, note });
      if (behavior?.throw) throw new Error("飞书接口挂了");
      if (behavior?.hang) await new Promise(() => {});
    },
  };
  return { card, calls };
}

test("进程退出收尾：在册卡片被翻成已停止并带上原因（TC-BRIDGE-LIVE-01）", async () => {
  resetLiveCards();
  const a = fakeCard("r-a");
  registerLiveCard(a.card);
  assert.equal(liveCardCount(), 1);

  const ok = await finishLiveCards();

  assert.equal(ok, 1);
  assert.deepEqual(a.calls, [{ status: "stopped", note: INTERRUPTED_NOTE }]);
  assert.equal(liveCardCount(), 0, "收尾后必须出册，避免重复收尾");
});

test("进程退出收尾：已收尾（注销）的卡片不会被再动一次（TC-BRIDGE-LIVE-02）", async () => {
  resetLiveCards();
  const done = fakeCard("r-done");
  const live = fakeCard("r-live");
  registerLiveCard(done.card);
  registerLiveCard(live.card);
  unregisterLiveCard(done.card);

  await finishLiveCards("x");

  assert.deepEqual(done.calls, [], "已经出终态的卡不该被改写");
  assert.equal(live.calls.length, 1);
});

test("进程退出收尾：单张卡挂死不阻塞退出，其余卡照常收尾（TC-BRIDGE-LIVE-03）", async () => {
  resetLiveCards();
  const stuck = fakeCard("r-stuck", { hang: true });
  const fine = fakeCard("r-fine");
  registerLiveCard(stuck.card);
  registerLiveCard(fine.card);

  const startedAt = Date.now();
  const ok = await finishLiveCards("y", 60);
  const elapsed = Date.now() - startedAt;

  assert.equal(ok, 1, "挂死那张算失败，另一张成功");
  assert.equal(fine.calls.length, 1);
  assert.ok(elapsed < 1000, `不能挂住退出路径，实际 ${elapsed}ms`);
});

test("进程退出收尾：单张卡报错不影响其他卡（TC-BRIDGE-LIVE-04）", async () => {
  resetLiveCards();
  const bad = fakeCard("r-bad", { throw: true });
  const good = fakeCard("r-good");
  registerLiveCard(bad.card);
  registerLiveCard(good.card);

  const ok = await finishLiveCards("z");

  assert.equal(ok, 1);
  assert.equal(good.calls.length, 1);
});

test("进程退出收尾：空册直接返回 0（TC-BRIDGE-LIVE-05）", async () => {
  resetLiveCards();
  assert.equal(await finishLiveCards(), 0);
});

test("退出 handler：收尾完成后调用 exit(0)，不留杀不死的进程（TC-BRIDGE-LIVE-06）", async () => {
  resetLiveCards();
  const card = fakeCard("r-exit");
  registerLiveCard(card.card);
  const exits: number[] = [];

  createExitHandler({ exit: (code) => exits.push(code) })();
  // handler 内部是异步收尾，等它跑完
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(card.calls.length, 1);
  assert.deepEqual(exits, [0]);
});

test("退出 handler：收尾抛错也必须 exit，且尊重 terminate=false（TC-BRIDGE-LIVE-07）", async () => {
  resetLiveCards();
  const bad = fakeCard("r-bad2", { throw: true });
  registerLiveCard(bad.card);
  const exits: number[] = [];

  // terminate=false：先验证不会擅自退出进程（组合场景）
  createExitHandler({ exit: (code) => exits.push(code), terminate: false })();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(exits, [], "terminate=false 时不得退出进程");

  // terminate 默认 true：即便收尾报错也要退出
  createExitHandler({ exit: (code) => exits.push(code) })();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(exits, [0]);
});

test("退出 handler：文案可覆盖（TC-BRIDGE-LIVE-08）", async () => {
  resetLiveCards();
  const card = fakeCard("r-note");
  registerLiveCard(card.card);

  createExitHandler({ note: "自定义说明", terminate: false })();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(card.calls, [{ status: "stopped", note: "自定义说明" }]);
});
