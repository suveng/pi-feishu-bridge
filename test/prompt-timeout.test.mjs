import assert from "node:assert/strict";
import { mock } from "node:test";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { waitForPrompt } = await import(join(repoRoot, "src/feishu/prompt-timeout.ts"));

function deferred() {
  let resolveFn;
  let rejectFn;
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

test("resolves when the prompt resolves (no timers configured)", async () => {
  await waitForPrompt(Promise.resolve("ok"), {
    notifyMs: 0,
    hardMs: 0,
    hardTimeoutMessage: "unused",
  });
});

test("fires the still-running notice once but never fails a long prompt", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  const d = deferred();
  let notified = 0;
  const run = waitForPrompt(d.promise, {
    notifyMs: 1000,
    hardMs: 0,
    hardTimeoutMessage: "unused",
    onStillRunning: () => {
      notified += 1;
    },
  });

  mock.timers.tick(999);
  assert.equal(notified, 0, "notice must not fire before the threshold");

  mock.timers.tick(1);
  assert.equal(notified, 1, "notice fires once at the threshold");

  let settled = false;
  const watcher = run.then(() => {
    settled = true;
  });
  void watcher;
  await mock.timers.tick(60_000);
  assert.equal(notified, 1, "notice fires only once");
  assert.equal(settled, false, "a long prompt must not be settled by the notice");

  d.resolve();
  await run;
  assert.equal(notified, 1);
});

test("does not fire the notice when the prompt finishes early", async () => {
  let notified = 0;
  await waitForPrompt(Promise.resolve("fast"), {
    notifyMs: 1_000_000,
    hardMs: 0,
    hardTimeoutMessage: "unused",
    onStillRunning: () => {
      notified += 1;
    },
  });
  assert.equal(notified, 0);
});

test("hard timeout rejects with the timeout message and calls onHardTimeout", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  const d = deferred();
  let hardCalls = 0;
  const run = waitForPrompt(d.promise, {
    notifyMs: 0,
    hardMs: 2000,
    hardTimeoutMessage: "Pi 模型处理超时（超过 2 秒）",
    onHardTimeout: async () => {
      hardCalls += 1;
    },
  });

  mock.timers.tick(2000);
  await assert.rejects(run, /Pi 模型处理超时（超过 2 秒）/);
  assert.equal(hardCalls, 1);
});

test("hard timeout is cancelled when the prompt resolves first", async () => {
  let hardCalls = 0;
  await waitForPrompt(Promise.resolve("fast"), {
    notifyMs: 0,
    hardMs: 1000,
    hardTimeoutMessage: "unused",
    onHardTimeout: () => {
      hardCalls += 1;
    },
  });
  assert.equal(hardCalls, 0);
});

test("a real prompt error propagates untouched", async () => {
  await assert.rejects(
    waitForPrompt(Promise.reject(new Error("real-model-error")), {
      notifyMs: 0,
      hardMs: 0,
      hardTimeoutMessage: "unused",
    }),
    /real-model-error/,
  );
});

test("等用户作答（feishu_ask）期间硬超时顺延，不会误杀整轮", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  const d = deferred();
  let hardCalls = 0;
  let paused = true;
  const run = waitForPrompt(d.promise, {
    notifyMs: 0,
    hardMs: 1000,
    hardTimeoutMessage: "timeout-while-paused",
    onHardTimeout: () => {
      hardCalls += 1;
    },
    isPaused: () => paused,
  });

  mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(hardCalls, 0, "等用户作答时不能触发硬超时");

  paused = false;
  mock.timers.tick(1000);
  await assert.rejects(run, /timeout-while-paused/);
  assert.equal(hardCalls, 1);
});
