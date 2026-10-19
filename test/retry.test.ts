/**
 * 启动重试的单测：
 * - 瞬时断连（ECONNRESET / socket hang up）按给定延迟序列重试，成功后返回
 * - 凭证类错误（403 / 99991672）不是「可重试」，一次就抛，不浪费等待
 * - 重试次数上限 = delaysMs 长度，用完后原样抛出最后一次错误
 * 背景：2026-10-19 22:02 daemon 启动时拉 tenant_access_token 撞两次 socket hang up，
 * 旧逻辑直接 process.exit(1)，飞书桥接断线且不重试。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isRetriableError, withBackoffRetry } from "../src/feishu/retry.ts";

function socketHangUp() {
  const cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  return new Error("socket hang up", { cause });
}

function credentialError() {
  return Object.assign(new Error("request failed with status code 403"), { response: { status: 403 } });
}

test("瞬时断连会按退避序列重试并最终成功", async () => {
  let calls = 0;
  const retries: Array<{ attempt: number; delayMs: number }> = [];

  const result = await withBackoffRetry(
    async () => {
      calls += 1;
      if (calls <= 2) throw socketHangUp();
      return "connected";
    },
    {
      delaysMs: [1, 2, 4],
      onRetry: (_error, attempt, delayMs) => retries.push({ attempt, delayMs }),
    },
  );

  assert.equal(result, "connected");
  assert.equal(calls, 3, "两次失败 + 一次成功");
  assert.deepEqual(retries, [
    { attempt: 1, delayMs: 1 },
    { attempt: 2, delayMs: 2 },
  ]);
});

test("凭证类错误不重试，立即抛出", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withBackoffRetry(
        async () => {
          calls += 1;
          throw credentialError();
        },
        { delaysMs: [1, 2, 4] },
      ),
    /status code 403/,
  );
  assert.equal(calls, 1, "403 不该重试");
});

test("重试次数用完就抛最后一次错误", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withBackoffRetry(
        async () => {
          calls += 1;
          throw socketHangUp();
        },
        { delaysMs: [1, 1] },
      ),
    /socket hang up/,
  );
  assert.equal(calls, 3, "首次 + 两次重试");
});

test("BotUnavailableError 包裹的 ECONNRESET 仍判为可重试", () => {
  // probeBotOpenId 会把原始错误放进 cause，判据要能递归进去（对应 transport.ts）
  const wrapped = Object.assign(new Error("socket hang up"), { name: "BotUnavailableError", cause: socketHangUp() });
  assert.equal(isRetriableError(wrapped), true);
  assert.equal(isRetriableError(credentialError()), false);
});
