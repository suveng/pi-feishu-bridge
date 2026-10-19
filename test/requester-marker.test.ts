/**
 * 「谁提的需求」标记（`[飞书提出人]`）的回归。
 *
 * 背景：`/req 新` 建出的需求此前完全查不出提出人（manifest 只有 stage/features/created_at/owner_*），
 * 根因是桥接从不把发送者身份交给模型。本组用例把这一环钉住：
 * 标记必须**在正文之前、形状固定、每条消息都有**，且引用别人的话提需求时不得把引用者当成提出人。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildRequesterMarker, buildPromptWithQuote } from "../src/feishu/messages.ts";
import { buildPrompt } from "../src/feishu/message-handler.ts";
import type { FeishuMessage } from "../src/feishu/types.ts";

function makeMsg(over: Partial<FeishuMessage> = {}): FeishuMessage {
  return {
    messageId: "om_1",
    chatId: "oc_1",
    chatType: "p2p",
    senderOpenId: "ou_abc",
    msgType: "text",
    content: '{"text":"给货币监控表加个导出"}',
    ...over,
  };
}

test("标记形状：open_id + chat_type，单行可被流程字符串匹配", () => {
  assert.equal(
    buildRequesterMarker("ou_abc", "p2p"),
    "[飞书提出人] open_id=ou_abc chat_type=p2p",
  );
  assert.equal(
    buildRequesterMarker("ou_group_1", "group"),
    "[飞书提出人] open_id=ou_group_1 chat_type=group",
  );
});

test("字段缺失时用「未知」占位，标记行仍必须存在", () => {
  assert.equal(buildRequesterMarker(undefined, undefined), "[飞书提出人] open_id=未知 chat_type=未知");
  assert.equal(buildRequesterMarker("  ", "group"), "[飞书提出人] open_id=未知 chat_type=group");
});

test("buildPrompt：标记在正文之前，原文一字不改地跟在后面", () => {
  const prompt = buildPrompt(makeMsg(), "给货币监控表加个导出", [], [], 0, false, []);
  const lines = prompt.split("\n");
  assert.equal(lines[0], "[飞书提出人] open_id=ou_abc chat_type=p2p");
  assert.equal(lines[1], "给货币监控表加个导出");
});

test("buildPrompt：纯图片消息（无文字）也带标记，且不丢原有的图片兜底文案", () => {
  const prompt = buildPrompt(makeMsg(), "", [], [{ data: "x", mimeType: "image/png" }], 0, true, []);
  const lines = prompt.split("\n");
  assert.equal(lines[0], "[飞书提出人] open_id=ou_abc chat_type=p2p");
  assert.equal(lines[1], "请根据图片内容进行分析。");
});

test("buildPrompt：群聊里标记只反映本条消息的发送者（不推断需求归属）", () => {
  const prompt = buildPrompt(makeMsg({ chatType: "group", senderOpenId: "ou_talker" }), "顺便加个筛选", [], [], 0, false, []);
  assert.match(prompt, /^\[飞书提出人\] open_id=ou_talker chat_type=group\n/);
});

test("引用别人的话提需求：全篇只有一个 open_id（发消息的人），提出人不会被引用者污染", () => {
  const base = buildPrompt(makeMsg(), "照这个改", [], [], 0, false, []);
  const withQuote = buildPromptWithQuote(base, {
    msgType: "text",
    text: "（某人转发的原话）把导出加一下",
  });
  // 引用块只带正文：不会多出一个 open_id
  assert.equal(withQuote.match(/open_id=/g)?.length, 1);
  assert.match(withQuote, /\[飞书提出人\] open_id=ou_abc chat_type=p2p/);
  assert.match(withQuote, /\[Quoted message\]/);
  assert.match(withQuote, /（某人转发的原话）把导出加一下/);
});

test("TC-BRIDGE-NAME-10 有姓名时追加在尾部，open_id 前缀形状不变", () => {
  assert.equal(
    buildRequesterMarker("ou_abc", "p2p", "张三"),
    "[飞书提出人] open_id=ou_abc chat_type=p2p name=张三",
  );
  // 空白姓名退回旧形状（缺 contact 字段权限就是这种情况）
  assert.equal(buildRequesterMarker("ou_abc", "p2p", "   "), "[飞书提出人] open_id=ou_abc chat_type=p2p");
});

test("TC-BRIDGE-NAME-11 buildPrompt 把姓名写进首行标记", () => {
  const prompt = buildPrompt(makeMsg(), "看下这个", [], [], 0, false, [], "张三");
  assert.match(prompt, /^\[飞书提出人\] open_id=ou_abc chat_type=p2p name=张三\n/);
});
