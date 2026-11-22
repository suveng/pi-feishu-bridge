import test from "node:test";
import assert from "node:assert/strict";
import { buildScheduleCard, buildScheduleFormCard, SCHEDULE_FORM } from "../src/feishu/schedule-cards.ts";

/**
 * 卡片本身不会被本地类型系统约束：飞书服务端才校验字段取值，写错了整张卡被拒
 * （HTTP 400 + 230099）。所以这里把两条已经踩过的规矩钉成用例：
 *
 * 1. form 容器里的每个交互组件都必须带 name，缺了 → 230099 / 200530；
 * 2. 输入框 max_length 的上限是 1000，写 2000 → 11310 "max_length exceed the default maximum 1000"。
 *    第二条是 2026-11-22 的事故：`/sched add` 每次都只回「Pi error: Request failed with status code 400」，
 *    因为卡片根本没发出去，而桥接把飞书的 code/msg 丢掉了。
 */

type Card = Record<string, unknown>;

function walk(node: unknown, visit: (n: Card) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const card = node as Card;
  visit(card);
  for (const value of Object.values(card)) walk(value, visit);
}

/** 飞书输入框 max_length 的硬上限 */
const FEISHU_INPUT_MAX_LENGTH = 1000;

test("新建任务表单：form 容器里每个交互组件都带 name", () => {
  const card = buildScheduleFormCard({ originLabel: "p2p 苏文广" });
  const missing: string[] = [];
  walk(card, (node) => {
    if (node.tag !== "input" && node.tag !== "button" && node.tag !== "select_static") return;
    if (typeof node.name !== "string" || !node.name) missing.push(String(node.tag));
  });
  assert.deepEqual(missing, [], "表单内交互组件缺 name 会被飞书整卡拒绝（230099 / 200530）");
});

test("新建任务表单：输入框 max_length 不超过飞书上限 1000", () => {
  const card = buildScheduleFormCard();
  const tooLong: Array<{ name: unknown; max_length: unknown }> = [];
  walk(card, (node) => {
    if (node.tag !== "input") return;
    const max = node.max_length;
    if (typeof max === "number" && max > FEISHU_INPUT_MAX_LENGTH) {
      tooLong.push({ name: node.name, max_length: max });
    }
  });
  assert.deepEqual(tooLong, [], `飞书输入框上限 ${FEISHU_INPUT_MAX_LENGTH}，超出会被拒（11310）`);
});

test("新建任务表单：三个字段与提交按钮的 name 都来自 SCHEDULE_FORM", () => {
  const card = buildScheduleFormCard();
  const names = new Set<string>();
  walk(card, (node) => {
    if (typeof node.name === "string") names.add(node.name);
  });
  for (const name of [SCHEDULE_FORM.nameField, SCHEDULE_FORM.timeField, SCHEDULE_FORM.promptField, SCHEDULE_FORM.submit]) {
    assert.ok(names.has(name), `缺少字段 ${name}：卡片回调就取不到这个值`);
  }
});

test("任务列表卡：没有任务时也能构造", () => {
  const card = buildScheduleCard([], { originLabel: "p2p 苏文广" }) as Card;
  assert.ok(Array.isArray(card.elements), "空列表卡也要有 elements");
});
