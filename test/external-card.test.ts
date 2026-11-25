import assert from "node:assert/strict";
import { test } from "node:test";
import { ExternalCardController, type ExternalCardSink } from "../src/feishu/external-card.ts";

/**
 * 外部唤醒轮兜底卡的单元测试。
 *
 * 覆盖的是「异步子 agent 跑完 / 后台任务回传把会话唤醒」这条路：
 * 那一轮没有 prompt 调用方，输出只能靠本控制器接成一张流式卡片，
 * 所以这里断言的重点是——不丢字、不弹空卡、不把上一轮尾巴重印一遍。
 */

type FakeSink = ExternalCardSink & {
  appended: string[];
  finals: string[];
  finishes: Array<{ status: string; note?: string }>;
};

function makeSink(): FakeSink {
  const sink: FakeSink = {
    appended: [],
    finals: [],
    finishes: [],
    append(delta) {
      sink.appended.push(delta);
    },
    ensureFinal(text) {
      sink.finals.push(text);
    },
    async finish(status, note) {
      sink.finishes.push({ status, note });
    },
  };
  return sink;
}

function makeController(options: {
  sink?: FakeSink;
  openerDelayMs?: number;
  openFailures?: number;
  orphanDeltaGuardMs?: number;
  maxTurnMs?: number;
} = {}) {
  let now = 1_000;
  const opened: string[] = [];
  const logs: string[] = [];
  let remainingFailures = options.openFailures ?? 0;
  const controller = new ExternalCardController(
    () => async (key) => {
      opened.push(key);
      if (options.openerDelayMs) await new Promise((r) => setTimeout(r, options.openerDelayMs));
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        return undefined;
      }
      return options.sink ?? makeSink();
    },
    {
      now: () => now,
      orphanDeltaGuardMs: options.orphanDeltaGuardMs ?? 2_000,
      maxTurnMs: options.maxTurnMs ?? 30 * 60_000,
      log: (event) => logs.push(event),
    },
  );
  return {
    controller,
    opened,
    logs,
    advance(ms: number) {
      now += ms;
    },
  };
}

test("agent_start 后到达的增量会开一张卡并写入正文", async () => {
  const sink = makeSink();
  const { controller, opened, logs } = makeController({ sink });

  controller.begin("p2p:u1", "agent_start");
  controller.observeDelta("p2p:u1", "评审通过");
  await new Promise((r) => setTimeout(r, 0));
  controller.observeDelta("p2p:u1", "，三条意见已闭环");
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(opened.length, 1, "同一轮只开一张卡");
  assert.deepEqual(sink.appended, ["评审通过", "，三条意见已闭环"]);
  assert.ok(logs.includes("feishu.external_card.opened"));
});

test("开卡是异步的，开卡前的增量不能丢", async () => {
  const sink = makeSink();
  const { controller } = makeController({ sink, openerDelayMs: 10 });

  controller.begin("p2p:u2", "agent_start");
  controller.observeDelta("p2p:u2", "前半段");
  controller.observeDelta("p2p:u2", "后半段");
  await new Promise((r) => setTimeout(r, 30));

  assert.deepEqual(sink.appended, ["前半段后半段"], "缓冲的正文要在卡就绪后一次补写");
});

test("没有 agent_start 的孤儿增量：距 prompt 结束太近就忽略（防上一轮尾巴重印）", () => {
  const sink = makeSink();
  const { controller, opened } = makeController({ sink });

  controller.notePromptEnd("p2p:u3");
  const accepted = controller.observeDelta("p2p:u3", "迟到的尾巴");

  assert.equal(accepted, false);
  assert.equal(opened.length, 0);
  assert.equal(controller.has("p2p:u3"), false);
});

test("孤儿增量过了冷却期仍会开卡（拿不到 agent_start 的运行时也要能推）", async () => {
  const sink = makeSink();
  const { controller, opened, advance } = makeController({ sink, orphanDeltaGuardMs: 2_000 });

  controller.notePromptEnd("p2p:u4");
  advance(3_000);

  assert.equal(controller.begin("p2p:u4", "orphan_delta"), true);
  assert.equal(opened.length, 0, "begin 本身不开卡，等第一段文本");
  controller.observeDelta("p2p:u4", "结果出来了");
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(opened.length, 1);
  assert.deepEqual(sink.appended, ["结果出来了"]);
});

test("纯工具轮（没有任何文本）不弹空卡", async () => {
  const sink = makeSink();
  const { controller, opened, logs } = makeController({ sink });

  controller.begin("p2p:u5", "agent_start");
  await controller.end("p2p:u5", () => "");

  assert.equal(opened.length, 0);
  assert.equal(sink.finishes.length, 0);
  assert.ok(logs.includes("feishu.external_card.empty_turn"));
});

test("轮次结束时用会话里的最终文本定稿，并收成 done", async () => {
  const sink = makeSink();
  const { controller } = makeController({ sink });

  controller.begin("p2p:u6", "agent_start");
  controller.observeDelta("p2p:u6", "结果出来了");
  await new Promise((r) => setTimeout(r, 0));
  await controller.end("p2p:u6", () => "结果出来了：全量 4730 passed / 0 failed");

  assert.deepEqual(sink.finals, ["结果出来了：全量 4730 passed / 0 failed"]);
  assert.deepEqual(sink.finishes, [{ status: "done", note: undefined }]);
  assert.equal(controller.has("p2p:u6"), false);
});

test("拿不到 transport/route（opener 返回 undefined）时不崩，也不刷日志", async () => {
  const { controller, logs } = makeController({ openFailures: 99 });

  controller.begin("p2p:u7", "agent_start");
  controller.observeDelta("p2p:u7", "a");
  await new Promise((r) => setTimeout(r, 0));
  controller.observeDelta("p2p:u7", "b");
  await new Promise((r) => setTimeout(r, 0));
  await controller.end("p2p:u7", () => "a");

  assert.equal(logs.filter((e) => e === "feishu.external_card.open_skipped").length, 1);
});

test("收尾失败不外抛，改报 failed", async () => {
  const sink = makeSink();
  sink.finish = async (status) => {
    if (status === "done") throw new Error("network down");
    sink.finishes.push({ status, note: "network down" });
  };
  const { controller } = makeController({ sink });

  controller.begin("p2p:u8", "agent_start");
  controller.observeDelta("p2p:u8", "正文");
  await new Promise((r) => setTimeout(r, 0));
  await controller.end("p2p:u8", () => "正文");

  assert.deepEqual(sink.finishes, [{ status: "failed", note: "network down" }]);
});

test("陈旧轮（超过 maxTurnMs）先收尾再重开，不把新输出写进旧卡", async () => {
  const oldSink = makeSink();
  const newSink = makeSink();
  let useNew = false;
  let now = 0;
  const controller = new ExternalCardController(
    () => async () => (useNew ? newSink : oldSink),
    { now: () => now, maxTurnMs: 60_000 },
  );

  controller.begin("p2p:u9", "agent_start");
  controller.observeDelta("p2p:u9", "旧轮正文");
  await new Promise((r) => setTimeout(r, 0));

  now = 120_000;
  useNew = true;
  assert.equal(controller.begin("p2p:u9", "agent_start"), true);
  // 旧轮收尾是异步发起的，让它的 await 走完
  await new Promise((r) => setTimeout(r, 0));
  controller.observeDelta("p2p:u9", "新轮正文");
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(oldSink.finishes.map((f) => f.status), ["done"]);
  assert.deepEqual(newSink.appended, ["新轮正文"]);
});
