/**
 * 飞书用户姓名解析的回归（`[飞书提出人] ... name=张三`）。
 *
 * 关键口径：姓名只是增强，**任何失败都必须降级回 undefined**，绝不能让消息处理失败。
 * 用例编号 TC-BRIDGE-NAME-01..09。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { resolveUserName, resetUserNameCache } from "../src/feishu/user-name.ts";

const CFG = { appId: "cli_test", appSecret: "secret_test", domain: "feishu" as const };

type Handler = (url: string) => unknown;

/** 造一个假 fetch：记录被调用的 URL，按 handler 返回 JSON */
function makeFetch(handler: Handler) {
  const calls: string[] = [];
  const fn = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    return { ok: true, status: 200, json: async () => handler(url) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** 标准的「token + 用户信息」两段响应 */
function standardHandler(userBody: unknown): Handler {
  return (url) => {
    if (url.includes("/auth/v3/tenant_access_token/internal")) {
      return { code: 0, tenant_access_token: "t-1", expire: 7200 };
    }
    return userBody;
  };
}

test("TC-BRIDGE-NAME-01 查到姓名时返回真名，并按 open_id 查询", async () => {
  resetUserNameCache();
  const { fn, calls } = makeFetch(standardHandler({ code: 0, data: { user: { name: "张三" } } }));
  const name = await resolveUserName("ou_abc", CFG, { fetchImpl: fn });
  assert.equal(name, "张三");
  assert.equal(calls.length, 2);
  assert.match(calls[1], /\/open-apis\/contact\/v3\/users\/ou_abc\?user_id_type=open_id$/);
});

test("TC-BRIDGE-NAME-02 接口成功但 name 为空（未开字段权限）时返回 undefined", async () => {
  resetUserNameCache();
  const { fn } = makeFetch(standardHandler({ code: 0, data: { user: { name: "" } } }));
  assert.equal(await resolveUserName("ou_empty", CFG, { fetchImpl: fn }), undefined);
});

test("TC-BRIDGE-NAME-03 接口报 41050（不在通讯录范围）时返回 undefined 且不抛", async () => {
  resetUserNameCache();
  const { fn } = makeFetch(standardHandler({ code: 41050, msg: "no user authority error" }));
  assert.equal(await resolveUserName("ou_outside", CFG, { fetchImpl: fn }), undefined);
});

test("TC-BRIDGE-NAME-04 查询超时返回 undefined，不阻塞调用方", async () => {
  resetUserNameCache();
  const hanging = (async () => {
    await new Promise(() => {});
    throw new Error("unreachable");
  }) as unknown as typeof fetch;
  const started = Date.now();
  assert.equal(await resolveUserName("ou_slow", CFG, { fetchImpl: hanging, timeoutMs: 30 }), undefined);
  assert.ok(Date.now() - started < 2000, "超时保护应让查询在 2 秒内返回");
});

test("TC-BRIDGE-NAME-05 姓名命中缓存：第二次不再发起任何请求", async () => {
  resetUserNameCache();
  const { fn, calls } = makeFetch(standardHandler({ code: 0, data: { user: { name: "李四" } } }));
  await resolveUserName("ou_cache", CFG, { fetchImpl: fn });
  const before = calls.length;
  assert.equal(await resolveUserName("ou_cache", CFG, { fetchImpl: fn }), "李四");
  assert.equal(calls.length, before, "缓存命中后不应再打接口");
});

test("TC-BRIDGE-NAME-06 查不到也进短缓存：10 分钟内不重复白打接口", async () => {
  resetUserNameCache();
  const { fn, calls } = makeFetch(standardHandler({ code: 0, data: { user: {} } }));
  await resolveUserName("ou_miss", CFG, { fetchImpl: fn });
  const before = calls.length;
  assert.equal(await resolveUserName("ou_miss", CFG, { fetchImpl: fn }), undefined);
  assert.equal(calls.length, before, "miss 也应缓存");
});

test("TC-BRIDGE-NAME-07 open_id 或应用凭证缺失时直接返回 undefined，零请求", async () => {
  resetUserNameCache();
  const { fn, calls } = makeFetch(standardHandler({ code: 0, data: { user: { name: "张三" } } }));
  assert.equal(await resolveUserName(undefined, CFG, { fetchImpl: fn }), undefined);
  assert.equal(await resolveUserName("  ", CFG, { fetchImpl: fn }), undefined);
  assert.equal(await resolveUserName("ou_abc", undefined, { fetchImpl: fn }), undefined);
  assert.equal(calls.length, 0);
});

test("TC-BRIDGE-NAME-08 lark 域名走 open.larksuite.com", async () => {
  resetUserNameCache();
  const { fn, calls } = makeFetch(standardHandler({ code: 0, data: { user: { name: "Wang" } } }));
  await resolveUserName("ou_lark", { ...CFG, domain: "lark" }, { fetchImpl: fn });
  assert.ok(calls.every((url) => url.startsWith("https://open.larksuite.com/")));
});

test("TC-BRIDGE-NAME-09 同一进程内 token 只取一次，可服务多个用户", async () => {
  resetUserNameCache();
  const { fn, calls } = makeFetch((url) =>
    url.includes("/auth/v3/tenant_access_token/internal")
      ? { code: 0, tenant_access_token: "t-keep", expire: 7200 }
      : { code: 0, data: { user: { name: "用户A" } } },
  );
  await resolveUserName("ou_u1", CFG, { fetchImpl: fn });
  await resolveUserName("ou_u2", CFG, { fetchImpl: fn });
  const tokenCalls = calls.filter((url) => url.includes("/auth/v3/tenant_access_token/internal"));
  assert.equal(tokenCalls.length, 1, "token 应缓存复用");
  assert.equal(calls.filter((url) => url.includes("/contact/v3/users")).length, 2);
});
