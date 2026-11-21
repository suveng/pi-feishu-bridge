import test from "node:test";
import assert from "node:assert/strict";
import { REGISTER_APP_TENANT_SCOPES } from "../src/feishu/app-register.ts";

test("扫码创建应用时申请群聊全量消息权限", () => {
  // 缺了 im:message.group_msg，飞书只推「@机器人」的群消息，
  // groupPolicy=open / groupKeywords 都会失效（2026-11-21 实测）
  assert.ok(
    REGISTER_APP_TENANT_SCOPES.includes("im:message.group_msg"),
    "缺少 im:message.group_msg，群聊非 @ 消息收不到",
  );
});

test("扫码创建应用时申请斜杠指令权限", () => {
  assert.ok(
    REGISTER_APP_TENANT_SCOPES.includes("application:app_slash_command:write"),
    "缺少 app_slash_command:write，指令面板注册不上",
  );
});

test("权限清单没有重复项", () => {
  assert.equal(new Set(REGISTER_APP_TENANT_SCOPES).size, REGISTER_APP_TENANT_SCOPES.length);
});
