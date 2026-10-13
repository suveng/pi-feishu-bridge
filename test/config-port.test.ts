import test from "node:test";
import assert from "node:assert/strict";
import {
  HARNESS_SOURCE,
  PI_SOURCE,
  defaultCardActionWebhookPort,
  setRuntimeSource,
} from "../src/feishu/config.ts";

test("默认卡片回调端口：Pi 与 DSH 按各自 base(3001/3002) 派生到 3003-3099 且互不相同", () => {
  setRuntimeSource(PI_SOURCE);
  const pi = defaultCardActionWebhookPort();
  setRuntimeSource(HARNESS_SOURCE);
  const harness = defaultCardActionWebhookPort();
  // 恢复默认，避免影响其他用例
  setRuntimeSource(PI_SOURCE);

  // 0.6.0 起实例目录跟着工作区走，端口一律按实例目录派生（不再固定占 3001/3002）
  for (const [name, port] of [["Pi", pi], ["DSH", harness]] as const) {
    assert.ok(port >= 3003 && port <= 3099, `${name} 端口应派生到 3003-3099，实际 ${port}`);
  }
  // 同一实例目录下两个 runtime 不能撞端口（否则会 EADDRINUSE）
  assert.notEqual(pi, harness);
  // 稳定：同一进程内重复调用必须一致（飞书后台的回调地址只需配一次）
  setRuntimeSource(PI_SOURCE);
  assert.equal(defaultCardActionWebhookPort(), pi);
});
