/**
 * 飞书 UI 上下文（ctx.ui.select/input/confirm/notify → 飞书卡片）的契约测试。
 *
 * 重点钉住与 rpiv rpc-fallback.ts walker 的对齐：
 * - select 点按钮必须回传「原始整行」（walker ① indexOf 匹配），自由输入回传文本（walker ④）。
 * - 取消 / 发送失败 → select/input 返回 undefined、confirm 返回 false。
 * 这些返回值格式只有 walker 会消费，单测里用假 askUser 直接断言，不依赖真实飞书。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createFeishuUiContext } from "../src/adapters/pi/feishu-ui-context.ts";
import type { AskOutcome, AskQuestion } from "../src/feishu/ask.ts";

/** 造一个假 askUser：记录收到的题目，并按预设 chosen / 标志结算 */
function fakeDeps(reply: { chosen?: string; canceled?: boolean; sendFailed?: boolean }) {
  const seen: AskQuestion[][] = [];
  const notified: string[] = [];
  const deps = {
    sessionKey: "group:test",
    askUser: async (_key: string, questions: AskQuestion[]): Promise<AskOutcome> => {
      seen.push(questions);
      return {
        answers: questions.map((q) => ({ header: q.header, question: q.question, chosen: reply.chosen })),
        timedOut: false,
        canceled: reply.canceled,
        sendFailed: reply.sendFailed,
      };
    },
    pushUiNotify: (text: string) => notified.push(text),
  };
  return { deps, seen, notified };
}

const OPTION_LINES = [
  "1. 推进开发 — 好处：快；坏处：返工风险",
  "2. 先停在这 — 好处：稳；坏处：慢",
  "3. Type something.",
];

test("select：点中选项回传原始整行（walker ① 匹配），题目选项被拆回 label/description", async () => {
  const { deps, seen } = fakeDeps({ chosen: "推进开发" });
  const ui = createFeishuUiContext(deps);
  const result = await ui.select("[范围] 先做哪个？", OPTION_LINES);
  assert.equal(result, OPTION_LINES[0], "必须回传整行，walker 才能 indexOf 命中");
  assert.equal(seen[0][0].options[0].label, "推进开发");
  assert.equal(seen[0][0].options[0].description, "好处：快；坏处：返工风险");
  assert.equal(seen[0][0].header, "范围", "短标题从 [header] 里取");
});

test("select：自由输入（不在选项里）原样回传文本（walker ④ 自定义答案）", async () => {
  const { deps } = fakeDeps({ chosen: "我自己敲的答案" });
  const ui = createFeishuUiContext(deps);
  const result = await ui.select("[范围] 先做哪个？", OPTION_LINES);
  assert.equal(result, "我自己敲的答案");
});

test("select：sentinel 行也回传整行，交由 walker 转 input（不在此识别 sentinel 文案）", async () => {
  const { deps } = fakeDeps({ chosen: "Type something." });
  const ui = createFeishuUiContext(deps);
  const result = await ui.select("[范围] 先做哪个？", OPTION_LINES);
  assert.equal(result, OPTION_LINES[2]);
});

test("select：取消 / 发送失败 → undefined；空选项 → undefined", async () => {
  const canceled = createFeishuUiContext(fakeDeps({ canceled: true }).deps);
  assert.equal(await canceled.select("题", OPTION_LINES), undefined);
  const failed = createFeishuUiContext(fakeDeps({ sendFailed: true }).deps);
  assert.equal(await failed.select("题", OPTION_LINES), undefined);
  const empty = createFeishuUiContext(fakeDeps({ chosen: "x" }).deps);
  assert.equal(await empty.select("题", []), undefined);
});

test("input：空 options 卡片，回传用户输入文本；取消 → undefined", async () => {
  const { deps, seen } = fakeDeps({ chosen: "用户输入的内容" });
  const ui = createFeishuUiContext(deps);
  const result = await ui.input("[标题] 请输入：");
  assert.equal(result, "用户输入的内容");
  assert.deepEqual(seen[0][0].options, [], "input 题不带选项，只渲染自由输入表单");
  const canceled = createFeishuUiContext(fakeDeps({ canceled: true }).deps);
  assert.equal(await canceled.input("题"), undefined);
});

test("confirm：选「确认」→ true，选「取消」/ 取消 → false", async () => {
  const yes = createFeishuUiContext(fakeDeps({ chosen: "确认" }).deps);
  assert.equal(await yes.confirm("标题", "确定吗？"), true);
  const no = createFeishuUiContext(fakeDeps({ chosen: "取消" }).deps);
  assert.equal(await no.confirm("标题", "确定吗？"), false);
  const canceled = createFeishuUiContext(fakeDeps({ canceled: true }).deps);
  assert.equal(await canceled.confirm("标题", "确定吗？"), false);
});

test("notify：文本路由到 pushUiNotify", () => {
  const { deps, notified } = fakeDeps({});
  const ui = createFeishuUiContext(deps);
  ui.notify("一条通知", "info");
  assert.deepEqual(notified, ["一条通知"]);
});

test("TUI 专用方法 no-op 不抛错（飞书无对应物）", () => {
  const ui = createFeishuUiContext(fakeDeps({}).deps);
  assert.doesNotThrow(() => {
    ui.setStatus("k", "v");
    ui.setWorkingMessage("x");
    ui.setTitle("t");
    ui.setWidget("k", ["a"]);
    ui.pasteToEditor("x");
    ui.setEditorText("x");
    assert.equal(ui.getEditorText(), "");
    assert.deepEqual(ui.getAllThemes(), []);
    assert.equal(ui.setTheme("dark").success, false);
  });
});