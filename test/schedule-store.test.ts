import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_JOBS, ScheduleStore, normalizeId } from "../src/feishu/schedule-store.ts";

const NOW = new Date(2026, 10, 22, 10, 30, 0).getTime();

function withStore(fn: (store: ScheduleStore, path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "feishu-sched-"));
  const path = join(dir, "schedules.pi.json");
  try {
    fn(new ScheduleStore(path), path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sample(overrides: Record<string, unknown> = {}) {
  return {
    name: "每日日报",
    prompt: "生成昨日订单日报",
    kind: "cron" as const,
    cron: "0 9 * * *",
    timeLabel: "每天 09:00",
    target: { chatId: "oc_group_1", chatType: "group" as const },
    ...overrides,
  };
}

test("创建后落盘，重新实例化（模拟重启）还能读回来", () => {
  withStore((store, path) => {
    const job = store.create(sample());
    assert.equal(job.enabled, true);
    assert.equal(job.runCount, 0);
    assert.equal(job.id.length, 6);

    const reloaded = new ScheduleStore(path);
    const again = reloaded.get(job.id);
    assert.ok(again);
    assert.equal(again!.name, "每日日报");
    assert.equal(again!.target.chatId, "oc_group_1");
    assert.equal(again!.timeLabel, "每天 09:00");
  });
});

test("暂停 / 恢复、改通知落点、删除", () => {
  withStore((store) => {
    const job = store.create(sample());

    assert.equal(store.update(job.id, { enabled: false })?.enabled, false);
    assert.equal(store.get(job.id)?.enabled, false);
    assert.equal(store.update(job.id, { enabled: true })?.enabled, true);

    const moved = store.retarget(job.id, { chatId: "oc_other", chatType: "p2p", updatedAt: NOW });
    assert.equal(moved?.target.chatId, "oc_other");
    assert.equal(moved?.target.chatType, "p2p");

    assert.equal(store.remove(job.id), true);
    assert.equal(store.get(job.id), undefined);
    assert.deepEqual(store.list(), []);
    assert.equal(store.remove(job.id), false);
  });
});

test("记录执行状态：markStarted 累加次数，markFinished 落结果", () => {
  withStore((store) => {
    const job = store.create(sample());
    store.markStarted(job.id, NOW);
    store.markFinished(job.id, { status: "failed", error: "模型超时" });
    const after = store.get(job.id)!;
    assert.equal(after.runCount, 1);
    assert.equal(after.lastRunAt, NOW);
    assert.equal(after.lastStatus, "failed");
    assert.equal(after.lastError, "模型超时");

    // 成功一次要把上次的错误清掉，否则卡片会一直显示旧报错
    store.markStarted(job.id, NOW + 1000);
    store.markFinished(job.id, { status: "ok" });
    const ok = store.get(job.id)!;
    assert.equal(ok.runCount, 2);
    assert.equal(ok.lastStatus, "ok");
    assert.equal(ok.lastError, undefined);
  });
});

test("编号容错：带 # 和大小写混写都能查到", () => {
  assert.equal(normalizeId(" #ABC123 "), "abc123");
  withStore((store) => {
    const job = store.create(sample());
    assert.ok(store.get(`#${job.id.toUpperCase()}`));
  });
});

test("坏文件不至于让调度器崩：非法条目被丢弃，合法条目保留", () => {
  withStore((_store, path) => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        jobs: {
          good: { id: "good", prompt: "跑一下", kind: "every", everyMs: 600_000, target: { chatId: "oc_1" } },
          noPrompt: { id: "noPrompt", kind: "every", everyMs: 600_000, target: { chatId: "oc_1" } },
          badKind: { id: "badKind", prompt: "跑", kind: "weekly", target: { chatId: "oc_1" } },
          cronNoExpr: { id: "cronNoExpr", prompt: "跑", kind: "cron", target: { chatId: "oc_1" } },
        },
      }),
    );
    const store = new ScheduleStore(path);
    assert.deepEqual(store.list().map((job) => job.id), ["good"]);
    assert.equal(store.get("good")?.enabled, true);
    assert.equal(store.get("good")?.timeLabel, "（未记录）");
  });
});

test("任务数上限会明确报错，而不是静默丢弃", () => {
  withStore((store) => {
    for (let i = 0; i < MAX_JOBS; i += 1) store.create(sample({ name: `任务${i}` }));
    assert.throws(() => store.create(sample({ name: "超额" })), /上限/);
    assert.equal(store.list().length, MAX_JOBS);
  });
});

test("文件里没有 id 字段时用键名兜底", () => {
  withStore((_store, path) => {
    writeFileSync(
      path,
      JSON.stringify({ version: 1, jobs: { abcdef: { prompt: "跑", kind: "every", everyMs: 600_000, target: { chatId: "oc_1" } } } }),
    );
    const store = new ScheduleStore(path);
    assert.equal(store.get("abcdef")?.id, "abcdef");
    assert.equal(store.get("abcdef")?.name, "abcdef");
    assert.match(readFileSync(path, "utf8"), /abcdef/);
  });
});
