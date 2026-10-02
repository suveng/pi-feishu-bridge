/**
 * 过程清单的接入层单测：卡片推送通道 + 中断兜底。
 *
 * 与 progress-note.test.ts 的分工：
 * - progress-note.test.ts：清单状态机与渲染（纯函数）
 * - 本文件：清单怎么落到卡片元件上、以及用户按停止后清单会不会留残影
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CardKitStream } from "../src/feishu/cardkit-stream.ts";
import { ReplyCard } from "../src/feishu/reply-card.ts";

type FetchCall = { url: string; init?: RequestInit };

/** 最小飞书 API stub：只认桥接会调的几条路径 */
function stubFetch(calls: FetchCall[]) {
  return async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/tenant_access_token/internal")) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: "t", expire: 7200 }));
    }
    if (url.endsWith("/cardkit/v1/cards")) {
      return new Response(JSON.stringify({ code: 0, data: { card_id: "card-1" } }));
    }
    if (url.endsWith("/messages/incoming-1/reply")) {
      return new Response(JSON.stringify({ code: 0, data: { message_id: "out-1" } }));
    }
    if (url.endsWith("/card-1/settings")) {
      return new Response(JSON.stringify({ code: 0 }));
    }
    if (url.includes("/cardkit/v1/cards/card-1")) {
      return new Response(JSON.stringify({ code: 0 }));
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

function elementIds(card: any): string[] {
  return (card?.body?.elements ?? []).map((e: any) => e.element_id).filter(Boolean);
}

test("progressEnabled 时建卡即预留清单元件，且排在正文之前", async () => {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = stubFetch(calls) as typeof fetch;
  try {
    const stream = new CardKitStream("app", "secret", "feishu", "incoming-1", async () => {}, {
      conversationKey: "p2p:u",
      runId: "r1",
      progressEnabled: true,
    });
    await stream.startImmediately();

    const createPayload = JSON.parse(String(calls[1].init?.body));
    assert.deepEqual(elementIds(JSON.parse(createPayload.data)), ["progress", "content"]);
    await stream.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("progressEnabled 为 false 时不建清单元件（零开销）", async () => {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = stubFetch(calls) as typeof fetch;
  try {
    const stream = new CardKitStream("app", "secret", "feishu", "incoming-1", async () => {}, {
      conversationKey: "p2p:u",
      runId: "r1",
    });
    await stream.startImmediately();
    const createPayload = JSON.parse(String(calls[1].init?.body));
    assert.deepEqual(elementIds(JSON.parse(createPayload.data)), ["content"]);
    await stream.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("清单单独走 elements/progress/content，且 sequence 与正文共享递增", async () => {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = stubFetch(calls) as typeof fetch;
  try {
    const stream = new CardKitStream("app", "secret", "feishu", "incoming-1", async () => {}, {
      conversationKey: "p2p:u",
      runId: "r1",
      progressEnabled: true,
    });
    await stream.startImmediately();
    stream.setProgressSource(() => "✅ bash  npm test · 1.2s");
    // 直接驱动一次 tick：不依赖 120ms 定时器，测试更稳
    await (stream as any).tick();

    const progressPut = calls.find((c) => c.url.includes("/elements/progress/content"));
    assert.ok(progressPut, "应当对 progress 元件发起 PUT");
    const body = JSON.parse(String(progressPut!.init?.body));
    assert.equal(body.content, "✅ bash  npm test · 1.2s");
    assert.equal(typeof body.sequence, "number");

    // 再推一次相同文本：不应重复 PUT（节流去重）
    const before = calls.filter((c) => c.url.includes("/elements/progress/content")).length;
    await (stream as any).tick();
    const after = calls.filter((c) => c.url.includes("/elements/progress/content")).length;
    assert.equal(after, before);

    // 内容变化后才再推，且 sequence 必须更大（飞书要求全卡严格递增）
    stream.setProgressSource(() => "✅ bash  npm test · 1.2s\n⏳ edit  a.ts");
    await (stream as any).tick();
    const puts = calls.filter((c) => c.url.includes("/elements/progress/content"));
    assert.equal(puts.length, before + 1);
    const seqs = puts.map((c) => JSON.parse(String(c.init?.body)).sequence as number);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(new Set(seqs).size, seqs.length);

    await stream.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/** 最小 transport：静态卡路径用不到真实网络 */
const stubTransport = {
  replyCard: async () => "m1",
  updateCard: async () => {},
};

test("用户按停止后清单不留 ⏳（abort 不发 tool_execution_end 的兜底）", async () => {
  const card = new ReplyCard("p2p:u1", "m0", stubTransport as any, {
    enabled: false,
    progressMode: "steps",
  });
  card.updateFromEvent({
    type: "tool_execution_start",
    toolCallId: "t1",
    toolName: "read",
    args: { path: "src/a.ts" },
  });
  card.updateFromEvent({ type: "tool_execution_end", toolCallId: "t1", isError: false });
  // 这个工具永远收不到 end：session.abort() 不保证发出该事件
  card.updateFromEvent({
    type: "tool_execution_start",
    toolCallId: "t2",
    toolName: "bash",
    args: { command: "sleep 300" },
  });
  assert.match(card.progressText, /⏳ bash/);

  await card.finish("stopped");

  assert.match(card.progressText, /⛔ bash/);
  assert.match(card.progressText, /已中断/);
  assert.doesNotMatch(card.progressText, /⏳/);
  assert.match(card.progressText, /✅ read/);
});

test("收尾后清单冻结，轮末残留事件不再改动执行记录", async () => {
  const card = new ReplyCard("p2p:u2", "m0", stubTransport as any, {
    enabled: false,
    progressMode: "steps",
  });
  await card.finish("done");
  const frozen = card.progressText;
  card.updateFromEvent({
    type: "tool_execution_start",
    toolCallId: "late",
    toolName: "bash",
    args: { command: "echo late" },
  });
  assert.equal(card.progressText, frozen);
});

test("progressMode=off 时不采集工具事件、不渲染清单", async () => {
  const card = new ReplyCard("p2p:u3", "m0", stubTransport as any, {
    enabled: false,
    progressMode: "off",
  });
  card.updateFromEvent({
    type: "tool_execution_start",
    toolCallId: "t1",
    toolName: "bash",
    args: { command: "npm test" },
  });
  assert.equal(card.progressText, "");
});
