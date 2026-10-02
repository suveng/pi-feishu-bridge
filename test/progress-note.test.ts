/**
 * 工具执行过程清单的单测。
 *
 * 覆盖：四档渲染、去重、折叠、中断兜底、命令单行化与截断。
 * 这些都是纯函数，不需要网络或卡片，所以单测能全部盖住。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ProgressTracker,
  formatDuration,
  formatProgressLine,
  progressNeedsElement,
  summarizeToolArgs,
} from "../src/feishu/progress-note.ts";
import { buildCardKitCardJson } from "../src/feishu/card-builder.ts";

/** 固定起点，避免测试依赖真实时间 */
const T0 = 1_700_000_000_000;

function tracker(mode: "off" | "steps" | "action" | "timeout", extra?: Record<string, unknown>) {
  return new ProgressTracker({
    mode,
    maxLines: 50,
    timeoutSeconds: 30,
    ...extra,
  } as any);
}

test("summarizeToolArgs 优先取 command/path，并压成单行", () => {
  assert.equal(summarizeToolArgs({ command: "rg -n   foo\n  src" }), "rg -n foo src");
  assert.equal(summarizeToolArgs({ path: "src/a.ts", offset: 1 }), "src/a.ts");
  assert.equal(summarizeToolArgs(undefined), "");
  assert.equal(summarizeToolArgs(""), "");
});

test("summarizeToolArgs 超长命令中部省略", () => {
  const cmd = `${"a".repeat(150)}${"b".repeat(150)}`;
  const out = summarizeToolArgs(cmd, 200);
  assert.equal(out.length, 200);
  assert.match(out, /…/);
  assert.equal(out.startsWith("a"), true);
  assert.equal(out.endsWith("b"), true);
});

test("summarizeToolArgs 无常见字段时退回 JSON", () => {
  assert.equal(summarizeToolArgs({ foo: "bar" }), '{"foo":"bar"}');
});

test("formatDuration 分档格式化", () => {
  assert.equal(formatDuration(320), "320ms");
  assert.equal(formatDuration(1240), "1.2s");
  assert.equal(formatDuration(65_000), "1m5s");
});

test("formatProgressLine 状态符号优先级：中断 > 进行中 > 失败 > 成功", () => {
  const base = {
    toolCallId: "t1",
    toolName: "bash",
    detail: "npm test",
    startedAt: T0,
  };
  assert.match(formatProgressLine({ ...base }), /^⏳/);
  assert.match(formatProgressLine({ ...base, endedAt: T0 + 1200, ok: true }), /^✅/);
  assert.match(formatProgressLine({ ...base, endedAt: T0 + 1200, ok: false }), /^❌/);
  assert.match(
    formatProgressLine({ ...base, endedAt: T0 + 1200, aborted: true, ok: false }),
    /^⛔/,
  );
});

test("steps 档渲染累积清单，含工具名、完整命令、耗时", () => {
  const t = tracker("steps");
  t.start("t1", "read", { path: "src/feishu/reply-card.ts" }, T0);
  t.end("t1", true, T0 + 200);
  t.start("t2", "bash", { command: 'rg -n "tool_execution" src/' }, T0 + 300);

  const out = t.render(T0 + 300);
  assert.ok(out);
  assert.match(out, /✅ read/);
  assert.match(out, /src\/feishu\/reply-card\.ts/);
  assert.match(out, /· 200ms/);
  assert.match(out, /⏳ bash/);
  assert.match(out, /rg -n "tool_execution" src\//);
  // 进行中的行不带耗时，避免每 push 都变
  assert.equal(out.split("\n")[1].includes("·"), false);
});

test("同一 toolCallId 重复 start 不新增行", () => {
  const t = tracker("steps");
  t.start("t1", "bash", { command: "a" }, T0);
  t.start("t1", "bash", { command: "b" }, T0 + 10);
  assert.equal(t.size, 1);
  assert.match(t.render(T0)!, /  b/);
});

test("未知 toolCallId 的 end 被忽略，不凭空补行", () => {
  const t = tracker("steps");
  t.end("nope", true, T0);
  assert.equal(t.size, 0);
  assert.equal(t.render(T0), undefined);
});

test("steps 档超过 maxLines 时首行 + 折叠计数 + 末尾若干行", () => {
  const t = tracker("steps", { maxLines: 5 });
  for (let i = 0; i < 12; i += 1) {
    t.start(`t${i}`, "bash", { command: `cmd-${i}` }, T0 + i);
    t.end(`t${i}`, true, T0 + i + 1);
  }
  const lines = t.render(T0 + 20)!.split("\n");
  assert.equal(lines.length, 5);
  assert.match(lines[0], /cmd-0/);
  // 12 条上 5 行：首行 cmd-0 + 折叠行 + 末尾 cmd-9/10/11，被折叠的是 cmd-1..8 共 8 条
  assert.match(lines[1], /中间 8 步已折叠/);
  assert.match(lines[4], /cmd-11/);
});

test("off 档不渲染，也不需要卡片预留元件", () => {
  const t = tracker("off");
  t.start("t1", "bash", { command: "npm test" }, T0);
  t.end("t1", true, T0 + 100);
  assert.equal(t.render(T0 + 200), undefined);
  assert.equal(progressNeedsElement("off"), false);
  assert.equal(progressNeedsElement("steps"), true);
  assert.equal(progressNeedsElement("action"), true);
  assert.equal(progressNeedsElement("timeout"), true);
});

test("action 档只显示当前工具；超阈值才带耗时", () => {
  const t = tracker("action");
  t.start("t1", "read", { path: "a.ts" }, T0);
  t.end("t1", true, T0 + 100);
  t.start("t2", "bash", { command: "npm test" }, T0 + 200);

  // 未超阈值：只有一行，没有耗时
  const early = t.render(T0 + 1000)!;
  assert.equal(early.split("\n").length, 1);
  assert.equal(early.includes("耗时"), false);

  // 超阈值：多出一行耗时
  const late = t.render(T0 + 31_000)!;
  assert.match(late, /耗时/);
});

test("action 档无进行中工具时显示最后一个已完成工具", () => {
  const t = tracker("action");
  t.start("t1", "read", { path: "a.ts" }, T0);
  t.end("t1", true, T0 + 100);
  const out = t.render(T0 + 200)!;
  assert.match(out, /✅ read/);
});

test("timeout 档平时不显示，超阈值才提示已执行多久", () => {
  const t = tracker("timeout");
  t.start("t1", "bash", { command: "npm run build" }, T0);
  assert.equal(t.render(T0 + 1000), undefined);
  assert.match(t.render(T0 + 31_000)!, /⚠️ bash 已执行/);
  // 工具结束后不再提示
  t.end("t1", true, T0 + 40_000);
  assert.equal(t.render(T0 + 50_000), undefined);
});

test("耗时按 5 秒量化，保证文本不会每 tick 都变", () => {
  const t = tracker("timeout");
  t.start("t1", "bash", { command: "npm test" }, T0);
  const a = t.render(T0 + 31_000);
  const b = t.render(T0 + 34_000); // 同一 5 秒桶内
  assert.equal(a, b);
  assert.notEqual(t.render(T0 + 36_000), a); // 跨桶后变化
});

test("abortAll 把所有进行中的行标成已中断（session.abort 不发 end 的兜底）", () => {
  const t = tracker("steps");
  t.start("t1", "read", { path: "a.ts" }, T0);
  t.end("t1", true, T0 + 100);
  t.start("t2", "bash", { command: "sleep 300" }, T0 + 200);

  assert.equal(t.abortAll(T0 + 5000), 1);
  const out = t.render(T0 + 5000)!;
  assert.match(out, /✅ read/);
  assert.match(out, /⛔ bash/);
  assert.match(out, /已中断/);
  // 二次调用不应重复计数
  assert.equal(t.abortAll(T0 + 6000), 0);
});

test("CardKit 卡带 progress 元件且排在 content 之前", () => {
  const card: any = buildCardKitCardJson({
    status: "running",
    body: "正文",
    key: "k1",
    progress: "✅ bash  npm test · 1.2s",
    streaming: true,
  });
  // 运行卡里还有一个停止按钮（不带 element_id），先滤掉
  const ids = card.body.elements.map((e: any) => e.element_id).filter(Boolean);
  assert.deepEqual(ids, ["progress", "content"]);
  assert.match(JSON.stringify(card.body.elements[0]), /npm test/);
});

test("progress 传空串时插占位元件（否则后续 PUT 没地方落）", () => {
  const card: any = buildCardKitCardJson({ status: "running", body: "", key: "k1", progress: "" });
  const ids = card.body.elements.map((e: any) => e.element_id).filter(Boolean);
  assert.deepEqual(ids, ["progress", "content"]);
  assert.equal(card.body.elements[0].content, " ");
});

test("progress 为 undefined 时不插元件（progressMode=off 零开销）", () => {
  const card: any = buildCardKitCardJson({ status: "running", body: "", key: "k1" });
  const ids = card.body.elements.map((e: any) => e.element_id).filter(Boolean);
  assert.deepEqual(ids, ["content"]);
});

test("终态卡保留定格清单", () => {
  const card: any = buildCardKitCardJson({
    status: "done",
    body: "最终回复",
    progress: "✅ bash  npm test · 1.2s",
  });
  const ids = card.body.elements.map((e: any) => e.element_id);
  assert.deepEqual(ids, ["progress", "content"]);
});
