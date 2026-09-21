/**
 * 「同一句话改个错别字重发」的拦截回归。
 *
 * 背景：用户把同一句请求改一个错别字又发一遍（真实案例：
 * 「加在那里比较好」→「加载那里比较好」），桥接会再开一轮，模型于是把同一个
 * 选择题又问一遍，看起来像「重复回复」。这组用例把阈值与放行边界钉住。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  NEAR_DUPLICATE_THRESHOLD,
  normalizeForSimilarity,
  stripRerunMarker,
  textSimilarity,
} from "../src/feishu/messages.ts";

test("归一化：去掉空白与中英文标点，只留内容", () => {
  assert.equal(
    normalizeForSimilarity("在设置增加开关选项吧, 加在那里比较好。"),
    "在设置增加开关选项吧加在那里比较好",
  );
  assert.equal(normalizeForSimilarity("Hello, World!"), "helloworld");
});

test("真实案例：改一个错别字的重发会被拦下", () => {
  const first = "在设置增加开关选项吧, 加在那里比较好, 你给我选";
  const second = "在设置增加开关选项吧, 加载那里比较好, 你给我选";
  const score = textSimilarity(first, second);
  assert.ok(score >= NEAR_DUPLICATE_THRESHOLD, `应判定为近重复，实际 ${score}`);
});

test("追问「…了吗」不会被误拦", () => {
  const score = textSimilarity("把开关加到设置页", "把开关加到设置页了吗");
  assert.ok(score < NEAR_DUPLICATE_THRESHOLD, `补一句追问不是重发，实际 ${score}`);
});

test("不同话题相似度很低，完全相同的文本为 1", () => {
  assert.ok(textSimilarity("改好了吗", "还没好吗") < NEAR_DUPLICATE_THRESHOLD);
  assert.equal(textSimilarity("同一句话", "同一句话"), 1);
  assert.equal(textSimilarity("", ""), 1);
  assert.equal(textSimilarity("有内容", ""), 0);
});

test("重发标记：剥掉前缀后才是真正送给模型的正文", () => {
  assert.equal(stripRerunMarker("重发 帮我看看这个需求"), "帮我看看这个需求");
  assert.equal(stripRerunMarker("重发：帮我看看这个需求"), "帮我看看这个需求");
  assert.equal(stripRerunMarker("/again 帮我看看这个需求"), "帮我看看这个需求");
  assert.equal(stripRerunMarker("/again: 帮我看看这个需求"), "帮我看看这个需求");
  assert.equal(stripRerunMarker("帮我看看这个需求"), "帮我看看这个需求", "没有前缀时原样返回");
  assert.equal(stripRerunMarker("重发 帮我看看") === "重发 帮我看看", false, "有前缀时必须变化（调用方据此判断强制重跑）");
});
