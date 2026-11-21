import test from "node:test";
import assert from "node:assert/strict";
import {
  computeNextRunAt,
  parseCron,
  parseScheduleSpec,
  MIN_EVERY_MS,
} from "../src/feishu/schedule-time.ts";

/** 固定「现在」：2026-11-22 10:30:00 本地时间，避免测试跟真实时钟耦合 */
const NOW = new Date(2026, 10, 22, 10, 30, 0).getTime();

function spec(text: string) {
  return parseScheduleSpec(text, NOW);
}

test("常见时间写法都能解析成 cron", () => {
  const daily = spec("每天 9:00") as any;
  assert.equal(daily.kind, "cron");
  assert.equal(daily.cron, "0 9 * * *");
  assert.equal(daily.description, "每天 09:00");

  const workday = spec("工作日 9:00") as any;
  assert.equal(workday.cron, "0 9 * * 1-5");

  const weekly = spec("每周一 10:00") as any;
  assert.equal(weekly.cron, "0 10 * * 1");

  const monthly = spec("每月 1 日 9:00") as any;
  assert.equal(monthly.cron, "0 9 1 * *");

  const raw = spec("cron 0 9 * * 1-5") as any;
  assert.equal(raw.cron, "0 9 * * 1-5");
});

test("间隔与一次性任务", () => {
  const every = spec("每 30 分钟") as any;
  assert.equal(every.kind, "every");
  assert.equal(every.everyMs, 30 * 60_000);

  const everyHour = spec("每 2 小时") as any;
  assert.equal(everyHour.everyMs, 2 * 3_600_000);

  const once = spec("2026-12-01 10:00") as any;
  assert.equal(once.kind, "once");
  assert.equal(once.at, new Date(2026, 11, 1, 10, 0, 0).getTime());
});

test("认不出的时间必须报错而不是静默当成每天", () => {
  const bad = spec("随便什么时候") as any;
  assert.equal(bad.ok, false);
  assert.match(bad.error, /时间/);
});

test("间隔不能小于 1 分钟（否则就是刷屏）", () => {
  const tooFast = spec("每 10 秒") as any;
  assert.equal(tooFast.ok, false);
  assert.equal(spec("每 1 分钟").everyMs, MIN_EVERY_MS);
});

test("cron 支持 * / 列表 / 步长 / 区间，周 7 等价 0", () => {
  const parsed = parseCron("*/15 9-18 * * 7");
  assert.deepEqual(parsed.minutes, [0, 15, 30, 45]);
  assert.deepEqual(parsed.daysOfWeek, [0]);
  assert.throws(() => parseCron("0 9 * *"));
  assert.throws(() => parseCron("61 9 * * *"));
});

test("computeNextRunAt：一次性任务恒定返回那个时刻", () => {
  const at = NOW + 3_600_000;
  const job = { kind: "once" as const, at, createdAt: NOW };
  assert.equal(computeNextRunAt(job, NOW), at);
});

test("computeNextRunAt：长期停摆的间隔任务只落下一个格点，不补一串", () => {
  const createdAt = NOW - 8 * 3_600_000;
  const lastRunAt = NOW - 8 * 3_600_000;
  const next = computeNextRunAt({ kind: "every", everyMs: 3_600_000, createdAt, lastRunAt }, NOW);
  assert.ok(next !== undefined);
  // 睡醒后应该「马上跑一次」（next <= 现在），而不是等下一个格点、更不是补 8 次
  assert.ok(next! <= NOW + 1_000);
  assert.ok(NOW - next! <= 3_600_000);
});

test("computeNextRunAt：cron 任务从上次触发之后算下一次，错过的点算到期（启动即补跑）", () => {
  const job = { kind: "cron" as const, cron: "0 9 * * *", createdAt: NOW - 86_400_000, lastRunAt: NOW - 86_400_000 };
  const next = computeNextRunAt(job, NOW);
  assert.equal(next, new Date(2026, 10, 22, 9, 0, 0).getTime());
});

test("computeNextRunAt：cron 写坏了返回 undefined，调度器跳过而不是崩", () => {
  assert.equal(computeNextRunAt({ kind: "cron", cron: "bogus", createdAt: NOW }, NOW), undefined);
});
