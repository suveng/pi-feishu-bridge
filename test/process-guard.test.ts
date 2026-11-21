/**
 * 进程级闸门测试：同一进程内第二份桥接扩展必须被判为重复并跳过。
 * 对应 2026-11-21 事故（全局 npm + 工作区 npm 双份副本，同进程加载两遍）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { claimProcessSlot, releaseProcessSlotForTest } from "../src/feishu/process-guard.ts";

test("process slot: 第一份占位成功，第二份被判重复并带上先到者信息", () => {
  releaseProcessSlotForTest();
  try {
    const first = claimProcessSlot(
      "/Users/me/.pi/agent/npm/node_modules/@suwenguang/pi-feishu-bridge/.pi/extensions/feishu/index.ts",
      new Date("2026-11-21T10:40:00.000Z"),
    );
    assert.equal(first.status, "claimed");

    const second = claimProcessSlot(
      "/repo/.pi/npm/node_modules/@suwenguang/pi-feishu-bridge/.pi/extensions/feishu/index.ts",
      new Date("2026-11-21T10:40:01.000Z"),
    );
    assert.equal(second.status, "duplicate");
    if (second.status === "duplicate") {
      assert.match(second.previous.entry, /\.pi\/agent\/npm/);
      assert.equal(second.previous.at, "2026-11-21T10:40:00.000Z");
    }
  } finally {
    releaseProcessSlotForTest();
  }
});

test("process slot: 清位后可以重新占位（用例隔离，避免污染）", () => {
  releaseProcessSlotForTest();
  try {
    assert.equal(claimProcessSlot("/a/index.ts").status, "claimed");
    releaseProcessSlotForTest();
    assert.equal(claimProcessSlot("/a/index.ts").status, "claimed");
  } finally {
    releaseProcessSlotForTest();
  }
});
