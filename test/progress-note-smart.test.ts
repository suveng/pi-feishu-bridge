/**
 * smart 进度档的单测。
 *
 * smart 档的目标是「防刷爆飞书接口」：历史只留跑够 1 分钟的步骤（最多 20 条），
 * 当前命令常驻最后一行，长命令每 30 秒才变一次耗时。
 * 这些都是纯逻辑，不起网络不起卡片，单测能全覆盖。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ProgressTracker,
  SMART_HISTORY_SECONDS,
  SMART_MAX_HISTORY,
  SMART_REFRESH_SECONDS,
  progressNeedsElement,
} from "../src/feishu/progress-note.ts";
import { parseRuntimeConfigValue } from "../src/feishu/runtime-config.ts";

/** 固定起点，避免依赖真实时间 */
const T0 = 1_700_000_000_000;
const MINUTE = 60_000;

function tracker(extra?: Record<string, unknown>) {
  return new ProgressTracker({
    mode: "smart",
    maxLines: 50,
    timeoutSeconds: 30,
    ...extra,
  } as any);
}

test("smart 常量口径：历史阈值 60s、上限 20 条、刷新粒度 30s", () => {
  assert.equal(SMART_HISTORY_SECONDS, 60);
  assert.equal(SMART_MAX_HISTORY, 20);
  assert.equal(SMART_REFRESH_SECONDS, 30);
  assert.equal(progressNeedsElement("smart"), true);
});

test("smart：短命令结束后不留痕（render 返回 undefined）", () => {
  const t = tracker();
  t.start("a", "bash", { command: "ls" }, T0);
  t.end("a", true, T0 + 3_000);
  assert.equal(t.render(T0 + 4_000), undefined);
});

test("smart：跑够 60s 的步骤留在历史里，并带耗时", () => {
  const t = tracker();
  t.start("a", "bash", { command: "npm test" }, T0);
  t.end("a", true, T0 + 65_000);
  const text = t.render(T0 + 70_000) ?? "";
  assert.match(text, /npm test/);
  assert.match(text, /1m5s/);
});

test("smart：刚好 60s 算长命令，59s 不算", () => {
  const exactly = tracker();
  exactly.start("a", "bash", { command: "npm run build" }, T0);
  exactly.end("a", true, T0 + MINUTE);
  assert.match(exactly.render(T0 + MINUTE + 1_000) ?? "", /npm run build/);

  const short = tracker();
  short.start("a", "bash", { command: "npm run lint" }, T0);
  short.end("a", true, T0 + MINUTE - 1_000);
  assert.equal(short.render(T0 + MINUTE + 1_000), undefined);
});

test("smart：历史最多 20 条，更早的折叠成一行省略提示", () => {
  const t = tracker();
  for (let i = 0; i < 25; i += 1) {
    const start = T0 + i * 120_000;
    t.start(`id-${i}`, "bash", { command: `cmd-${i}` }, start);
    t.end(`id-${i}`, true, start + 70_000);
  }
  const lines = (t.render(T0 + 25 * 120_000) ?? "").split("\n");
  // 1 行省略提示 + 20 行步骤
  assert.equal(lines.length, 21);
  assert.match(lines[0], /更早 5 步已省略/);
  // 尾部保留的是最近 5 条
  assert.match(lines[20], /cmd-24/);
  assert.doesNotMatch(lines.join("\n"), /cmd-0/);
});

test("smart：运行中的命令常驻最后一行，跑够 60s 才带耗时且按 30s 量化", () => {
  const t = tracker();
  t.start("a", "bash", { command: "cargo build" }, T0);
  // 59s：命令行在，但没有耗时
  const early = t.render(T0 + 59_000) ?? "";
  assert.match(early, /cargo build/);
  assert.doesNotMatch(early, /已 /);
  // 61s：量化到 60s
  assert.match(t.render(T0 + 61_000) ?? "", /已 1m0s/);
  // 89s 仍是 60s（30s 粒度），91s 才跳到 1m30s
  assert.match(t.render(T0 + 89_000) ?? "", /已 1m0s/);
  assert.match(t.render(T0 + 91_000) ?? "", /已 1m30s/);
});

test("smart：历史 + 运行中同时存在时，运行中排在最后一行", () => {
  const t = tracker();
  t.start("a", "bash", { command: "npm install" }, T0);
  t.end("a", true, T0 + 80_000);
  t.start("b", "bash", { command: "npm run build" }, T0 + 90_000);
  const lines = (t.render(T0 + 95_000) ?? "").split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /npm install/);
  assert.match(lines[1], /npm run build/);
});

test("smart：折叠标题按长步骤口径计数，运行中显示当前命令", () => {
  const t = tracker();
  t.start("a", "bash", { command: "ls" }, T0);
  t.end("a", true, T0 + 1_000);
  t.start("b", "bash", { command: "npm test" }, T0 + 2_000);
  t.end("b", true, T0 + 70_000);
  // 两条步骤里只有一条够长 → 标题计 1，清单也只有 1 行，数字对得上
  assert.equal(t.renderTitle(T0 + 80_000), "执行过程（共 1 步）");

  t.start("c", "bash", { command: "cargo test" }, T0 + 90_000);
  const running = t.renderTitle(T0 + 100_000);
  assert.match(running, /正在执行 bash/);
  assert.match(running, /cargo test/);
});

test("smart：全是短命令时标题不写「共 0 步」", () => {
  const t = tracker();
  t.start("a", "bash", { command: "ls" }, T0);
  t.end("a", true, T0 + 1_000);
  assert.equal(t.renderTitle(T0 + 2_000), "执行过程");
});

test("smart：配置层接受 smart（runtime 与 config 同一套白名单）", () => {
  const ok = parseRuntimeConfigValue("progressMode", "smart");
  assert.deepEqual(ok, { ok: true, value: "smart" });
  const bad = parseRuntimeConfigValue("progressMode", "noisy");
  assert.equal(bad.ok, false);
});
