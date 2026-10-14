import test from "node:test";
import assert from "node:assert/strict";
import {
  PI_SOURCE,
  defaultCardActionWebhookPort,
  setRuntimeSource,
} from "../src/feishu/config.ts";

test("默认卡片回调端口：按实例目录派生到 3003-3099，同一进程内稳定", () => {
  setRuntimeSource(PI_SOURCE);
  const port = defaultCardActionWebhookPort();

  // 0.6.0 起实例目录跟着工作区走，端口一律按实例目录派生（不再固定占 3001）
  assert.ok(port >= 3003 && port <= 3099, `端口应派生到 3003-3099，实际 ${port}`);
  // 稳定：同一进程内重复调用必须一致（飞书后台的回调地址只需配一次）
  assert.equal(defaultCardActionWebhookPort(), port);
  assert.equal(PI_SOURCE.id, "pi");
});
