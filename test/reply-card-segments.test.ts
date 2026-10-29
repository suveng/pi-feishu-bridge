/**
 * 回复卡「分段」回归测试（feishu_ask 暂停/恢复）。
 *
 * 背景：模型一边流式回答一边调 feishu_ask 时，三张卡（暂停的回答卡 / 选择题卡 /
 * 继续输出的新卡）必须按时间平铺、顺序连贯，且任何时刻都不能留下一张
 * 永远停在「等你选择」的僵尸卡。这里把那条契约钉住。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ReplyCard, resolveCardTarget } from "../src/feishu/reply-card.ts";

type Sent = { kind: "reply" | "create" | "update"; target: string; card: any };

function fakeTransport() {
  const sent: Sent[] = [];
  let seq = 0;
  return {
    sent,
    replyCard(messageId: string, card: object) {
      sent.push({ kind: "reply", target: messageId, card });
      return Promise.resolve(`m${++seq}`);
    },
    createCard(chatId: string, card: object) {
      sent.push({ kind: "create", target: chatId, card });
      return Promise.resolve(`m${++seq}`);
    },
    updateCard(messageId: string, card: object) {
      sent.push({ kind: "update", target: messageId, card });
      return Promise.resolve();
    },
  };
}

function headerTitle(card: any) {
  return card?.header?.title?.content;
}

/** 非流式路径（enabled:false），便于断言每一次写卡动作 */
function staticCard(transport: ReturnType<typeof fakeTransport>) {
  return new ReplyCard("p2p:user", { chatId: "oc_chat" }, transport, { enabled: false });
}

test("resolveCardTarget：普通会话平铺，话题群留在回复里", () => {
  const flat = resolveCardTarget({
    chatId: "oc_1",
    chatType: "group",
    lastMessageId: "om_1",
  });
  assert.deepEqual(flat, { chatId: "oc_1" }, "普通会话必须平铺（多条 reply 会被飞书折叠成一条）");

  const threaded = resolveCardTarget({
    chatId: "oc_2",
    chatType: "group",
    threadMessageId: "omt_1",
    lastMessageId: "om_2",
  });
  assert.deepEqual(
    threaded,
    { replyToMessageId: "om_2", replyInThread: true },
    "话题群必须 reply，且带上 replyInThread，否则图片会落在话题外",
  );
});

test("暂停把当前段定格，恢复开新卡，正文不串段", async () => {
  const transport = fakeTransport();
  const card = staticCard(transport);

  await card.start();
  card.append("第一段正文");
  await card.pauseForAsk();

  assert.equal(card.paused, true, "暂停期间必须处于 paused");
  card.append("暂停期间不该落盘"); // 必须被 status 守卫挡住

  await card.resume();
  assert.equal(card.paused, false, "恢复后不能再是 paused");
  card.append("第二段正文");
  // 正常情况：轮末拿到的是整轮文本，长度对得上账
  await card.completeWithAnswer("第一段正文第二段正文");

  const creates = transport.sent.filter((item) => item.kind === "create");
  assert.equal(creates.length, 2, "暂停前一段 + 恢复后一段 = 两张卡");

  const pausedUpdate = transport.sent.find(
    (item) => item.kind === "update" && headerTitle(item.card) === "等你选择",
  );
  assert.ok(pausedUpdate, "暂停卡必须被刷成「等你选择」");
  const pausedText = JSON.stringify(pausedUpdate!.card);
  assert.match(pausedText, /第一段正文/);
  assert.equal(pausedText.includes("第二段正文"), false, "暂停卡不能拿到后面才产生的正文");
  assert.equal(pausedText.includes("暂停期间不该落盘"), false, "暂停期间产生的 delta 必须被丢掉");

  const answeredUpdate = transport.sent.find(
    (item) => item.kind === "update" && headerTitle(item.card) === "已选择",
  );
  assert.ok(answeredUpdate, "恢复时要把暂停卡翻成「已选择」，否则永远停在「等你选择」");

  const secondCard = creates[1].card;
  assert.equal(headerTitle(secondCard), "回复（接上条）", "续段要交代它接的是哪一段");

  const finalUpdate = transport.sent.at(-1)!;
  assert.equal(finalUpdate.kind, "update");
  assert.equal(
    headerTitle(finalUpdate.card),
    "回复（接上条）",
    "续段的终态也保留标题覆盖，否则用户看不出这张卡接的是哪一段",
  );
  const finalText = JSON.stringify(finalUpdate.card);
  assert.match(finalText, /第二段正文/);
  assert.equal(finalText.includes("第一段正文"), false, "续段不能把上一段的正文重印一遍");
});

test("取消路径：暂停后直接收尾，不能留下 paused", async () => {
  const transport = fakeTransport();
  const card = staticCard(transport);

  await card.start();
  card.append("写了一半");
  await card.pauseForAsk();
  assert.equal(card.paused, true);

  // 被停止/被新消息打断：askUser 的临界区出口会走这一支
  await card.finish("stopped", "提问已结束");
  assert.equal(card.paused, false, "终态必须把 paused 消掉");

  const last = transport.sent.at(-1)!;
  assert.equal(headerTitle(last.card), "已停止");
  assert.match(JSON.stringify(last.card), /写了一半/);
});

test("轮末只给最后一条 assistant 消息（长度对不上）时不能丢字", async () => {
  const transport = fakeTransport();
  const card = staticCard(transport);

  await card.start();
  card.append("第一段");
  await card.pauseForAsk();
  await card.resume();
  card.append("第二段");

  // 真实情况：answer 是「最后一条 assistant 消息」，不含暂停前那一段
  await card.completeWithAnswer("第二段");

  const finalUpdate = transport.sent.at(-1)!;
  const finalText = JSON.stringify(finalUpdate.card);
  assert.match(finalText, /第二段/, "最后一段正文不能因为长度对不上被丢掉");
  assert.equal(finalText.includes("第一段"), false, "更不能把上一段重印进来");
});

test("轮末给整轮文本（长度对得上）时按 offset 切段，不重复上一段", async () => {
  const transport = fakeTransport();
  const card = staticCard(transport);

  await card.start();
  card.append("AA");
  await card.pauseForAsk();
  await card.resume();
  card.append("BB");
  await card.completeWithAnswer("AABB");

  const finalUpdate = transport.sent.at(-1)!;
  const finalText = JSON.stringify(finalUpdate.card);
  assert.match(finalText, /BB/);
  assert.equal(finalText.includes("AA"), false, "offset 切段后不能把暂停前的正文再印一遍");
});
