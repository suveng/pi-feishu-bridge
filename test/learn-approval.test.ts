/**
 * 进化审批客户端单测（node --test）。
 *
 * 运行：
 *   cd .pi/ax-feishu-bridge
 *   node --experimental-strip-types --experimental-transform-types --import ./test/register.mjs \
 *     --test test/learn-approval.test.ts
 *
 * 覆盖重点：
 *   - 状态映射（认不出的状态绝不能当成「已批准」）
 *   - 审批定义取控件 / form 构造（决定实例能不能建出来）
 *   - create() 只建单不轮询、query() 按实例号查一次（拆分后的主形态）
 *   - 轮询到终态与超时（超时也绝不能放行）；超时后同一实例号可续查
 *   - 建实例失败要抛错 / 返回 ok=false，不能静默返回「通过」
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LearnApprovalClient,
  buildInstanceForm,
  formatApprovalOutcome,
  formatSubmitOutcome,
  mapInstanceStatus,
  pickFormWidget,
} from "../src/feishu/learn-approval.ts";
import { parseLearnApproval } from "../src/feishu/config.ts";

/* ---------------- 状态映射 ---------------- */

test("状态映射：飞书大写状态逐一对应", () => {
  assert.equal(mapInstanceStatus("APPROVED"), "APPROVED");
  assert.equal(mapInstanceStatus("REJECTED"), "REJECTED");
  assert.equal(mapInstanceStatus("CANCELED"), "CANCELED");
  assert.equal(mapInstanceStatus("PENDING"), "PENDING");
});

test("状态映射：认不出的值一律按在途，绝不能变成已批准", () => {
  assert.equal(mapInstanceStatus(undefined), "PENDING");
  assert.equal(mapInstanceStatus(""), "PENDING");
  assert.equal(mapInstanceStatus("SOMETHING_NEW"), "PENDING");
  assert.equal(mapInstanceStatus("deleted"), "CANCELED");
});

/* ---------------- 审批定义取控件 ---------------- */

test("取控件：form 是 JSON 字符串（官方形态）", () => {
  const definition = { form: JSON.stringify({ widgets: [{ id: "widget1", type: "input" }] }) };
  assert.deepEqual(pickFormWidget(definition), { id: "widget1", type: "input" });
});

test("取控件：优先多行文本，没有才退回第一个控件", () => {
  const withTextarea = {
    form: JSON.stringify({ widgets: [{ id: "w1", type: "input" }, { id: "w2", type: "textarea" }] }),
  };
  assert.deepEqual(pickFormWidget(withTextarea), { id: "w2", type: "textarea" });

  const onlyNumber = { form: JSON.stringify({ widgets: [{ id: "w9", type: "number" }] }) };
  assert.deepEqual(pickFormWidget(onlyNumber), { id: "w9", type: "number" });
});

test("取控件：form 直接是数组也能认", () => {
  assert.deepEqual(pickFormWidget({ form: [{ id: "widgetA", type: "textarea" }] }), {
    id: "widgetA",
    type: "textarea",
  });
});

test("取控件：form 是坏 JSON / 空定义时返回 undefined（交给上层报错）", () => {
  assert.equal(pickFormWidget({ form: "{not json" }), undefined);
  assert.equal(pickFormWidget({}), undefined);
  assert.equal(pickFormWidget(undefined), undefined);
});

test("form 构造：产出压缩 JSON 字符串，保留控件原类型", () => {
  const form = buildInstanceForm({ id: "w2", type: "textarea" }, "候选点 1：改 learn.md");
  assert.equal(typeof form, "string");
  assert.deepEqual(JSON.parse(form), [{ id: "w2", type: "textarea", value: "候选点 1：改 learn.md" }]);
});

/* ---------------- 配置解析 ---------------- */

test("配置解析：缺 approvalCode 视为未配置", () => {
  assert.equal(parseLearnApproval(undefined), undefined);
  assert.equal(parseLearnApproval({}), undefined);
  assert.equal(parseLearnApproval({ approvalCode: "   " }), undefined);
  assert.equal(parseLearnApproval("not-an-object"), undefined);
});

test("配置解析：正常值保留，非法超时/间隔退回默认", () => {
  assert.deepEqual(parseLearnApproval({ approvalCode: " abc ", timeoutSec: 60, pollIntervalSec: 3 }), {
    approvalCode: "abc",
    timeoutSec: 60,
    pollIntervalSec: 3,
  });
  assert.deepEqual(parseLearnApproval({ approvalCode: "abc", timeoutSec: -1, pollIntervalSec: 0 }), {
    approvalCode: "abc",
    timeoutSec: undefined,
    pollIntervalSec: undefined,
  });
});

/* ---------------- 审批结果文案 ---------------- */

test("结果文案：只有 APPROVED 才说可以改文件", () => {
  for (const status of ["REJECTED", "CANCELED", "TIMEOUT", "PENDING"] as const) {
    const text = formatApprovalOutcome({ status });
    assert.ok(text.includes("不要"), `${status} 应明确禁止改动，实际：${text}`);
    assert.ok(!text.includes("可以按被授权的候选点落地"), `${status} 不应放行，实际：${text}`);
  }
  assert.ok(formatApprovalOutcome({ status: "APPROVED" }).includes("可以按被授权的候选点落地"));
});

/* ---------------- 客户端主流程 ---------------- */

/** 造一个假飞书 API：定义/建实例/查状态都走它 */
function fakeApi(options: {
  widget?: { id: string; type: string } | undefined;
  statuses?: string[];
  createFails?: boolean;
}) {
  const calls: Array<{ url: string; method: string; data?: any }> = [];
  const statuses = [...(options.statuses ?? ["APPROVED"])];
  return {
    calls,
    async request(args: { url: string; method: string; data?: any }) {
      calls.push(args);
      if (args.method === "GET" && args.url.includes("/approvals/")) {
        if (options.widget === undefined) return { data: {} };
        return { data: { form: JSON.stringify({ widgets: [options.widget] }) } };
      }
      if (args.method === "POST" && args.url.endsWith("/instances")) {
        if (options.createFails) return { code: 1390002, msg: "approval code not found" };
        return { data: { instance_code: "INST-1" } };
      }
      if (args.method === "GET" && args.url.includes("/instances/")) {
        const status = statuses.length > 1 ? statuses.shift()! : statuses[0];
        return { data: { status } };
      }
      throw new Error(`unexpected call: ${args.method} ${args.url}`);
    },
  };
}

function makeClient(api: any, config = { approvalCode: "AP-1" }) {
  return new LearnApprovalClient({
    api,
    config,
    sleep: async () => {},
    now: () => Date.now(),
    log: () => {},
  });
}

test("主流程：轮询到 APPROVED", async () => {
  const api = fakeApi({ widget: { id: "w1", type: "textarea" }, statuses: ["PENDING", "APPROVED"] });
  const result = await makeClient(api).request({ body: "候选点 1", applicantOpenId: "ou_user" });
  assert.equal(result.status, "APPROVED");
  assert.equal(result.instanceCode, "INST-1");

  const createCall = api.calls.find((c) => c.method === "POST");
  assert.equal(createCall?.data.approval_code, "AP-1");
  assert.equal(createCall?.data.open_id, "ou_user");
  assert.deepEqual(JSON.parse(createCall?.data.form), [{ id: "w1", type: "textarea", value: "候选点 1" }]);
});

test("主流程：驳回不放行", async () => {
  const api = fakeApi({ widget: { id: "w1", type: "input" }, statuses: ["REJECTED"] });
  const result = await makeClient(api).request({ body: "候选点 2", applicantOpenId: "ou_user" });
  assert.equal(result.status, "REJECTED");
});

test("主流程：一直 PENDING 时超时，且不放行", async () => {
  let clock = 0;
  const api = fakeApi({ widget: { id: "w1", type: "input" }, statuses: ["PENDING"] });
  const client = new LearnApprovalClient({
    api,
    config: { approvalCode: "AP-1", timeoutSec: 10, pollIntervalSec: 1 },
    // 每次 sleep 就把时钟往前推 4 秒，10 秒超时 → 轮询两三次后结束
    sleep: async () => {
      clock += 4000;
    },
    now: () => clock,
    log: () => {},
  });
  const result = await client.request({ body: "候选点 3", applicantOpenId: "ou_user" });
  assert.equal(result.status, "TIMEOUT");
  assert.equal(result.instanceCode, "INST-1");
});

test("主流程：单次查询失败不结束等待，下一轮继续", async () => {
  let pollCount = 0;
  const api = {
    async request(args: { url: string; method: string; data?: any }) {
      if (args.method === "GET" && args.url.includes("/approvals/")) {
        return { data: { form: JSON.stringify({ widgets: [{ id: "w1", type: "input" }] }) } };
      }
      if (args.method === "POST") return { data: { instance_code: "INST-2" } };
      pollCount += 1;
      if (pollCount === 1) throw new Error("network down");
      return { data: { status: "APPROVED" } };
    },
  };
  const result = await makeClient(api).request({ body: "候选点 4", applicantOpenId: "ou_user" });
  assert.equal(result.status, "APPROVED");
  assert.equal(pollCount, 2);
});

test("主流程：建实例失败要抛错，不能静默返回通过", async () => {
  const api = fakeApi({ widget: { id: "w1", type: "input" }, createFails: true });
  await assert.rejects(
    () => makeClient(api).request({ body: "候选点 5", applicantOpenId: "ou_user" }),
    /创建审批实例失败/,
  );
});

test("主流程：定义里没有可填控件时抛错并提示去加控件", async () => {
  const api = fakeApi({ widget: undefined });
  await assert.rejects(
    () => makeClient(api).request({ body: "候选点 6", applicantOpenId: "ou_user" }),
    /找不到可填写的文本控件/,
  );
});

test("主流程：拿不到发起人 open_id 时直接拒绝，不打飞书接口", async () => {
  const api = fakeApi({ widget: { id: "w1", type: "input" } });
  const result = await makeClient(api).request({ body: "候选点 7", applicantOpenId: "" });
  assert.equal(result.status, "CANCELED");
  assert.equal(api.calls.length, 0);
});

test("主流程：审批定义只查一次（缓存），不白吃限频", async () => {
  const api = fakeApi({ widget: { id: "w1", type: "input" }, statuses: ["APPROVED"] });
  const client = makeClient(api);
  await client.request({ body: "a", applicantOpenId: "ou_user" });
  await client.request({ body: "b", applicantOpenId: "ou_user" });
  const definitionCalls = api.calls.filter((c) => c.method === "GET" && c.url.includes("/approvals/"));
  assert.equal(definitionCalls.length, 1);
});

/* ---------------- 拆分后的 create() / query() ---------------- */

test("create：只建单立即返回实例号，不查状态", async () => {
  const api = fakeApi({ widget: { id: "w1", type: "textarea" }, statuses: ["APPROVED"] });
  const result = await makeClient(api).create({ body: "候选点 8", applicantOpenId: "ou_user" });
  assert.deepEqual(result, { ok: true, instanceCode: "INST-1" });
  const polls = api.calls.filter((c) => c.method === "GET" && c.url.includes("/instances/"));
  assert.equal(polls.length, 0, "create 不应查状态（等审批人会卡死整轮对话）");
});

test("create：拿不到发起人 / 定义缺控件 / 建单失败都返回 ok=false，不抛错", async () => {
  const noApplicant = fakeApi({ widget: { id: "w1", type: "input" } });
  const r1 = await makeClient(noApplicant).create({ body: "a", applicantOpenId: "" });
  assert.equal(r1.ok, false);
  assert.equal(noApplicant.calls.length, 0, "没有发起人时不该打飞书接口");

  const noWidget = fakeApi({ widget: undefined });
  const r2 = await makeClient(noWidget).create({ body: "a", applicantOpenId: "ou_user" });
  assert.equal(r2.ok, false);
  assert.match(r2.detail ?? "", /找不到可填写的文本控件/);

  const createFails = fakeApi({ widget: { id: "w1", type: "input" }, createFails: true });
  const r3 = await makeClient(createFails).create({ body: "a", applicantOpenId: "ou_user" });
  assert.equal(r3.ok, false);
  assert.match(r3.detail ?? "", /创建审批实例失败/);
});

test("query：四种状态逐一映射，认不出的值仍按在途", async () => {
  const cases: Array<[string, string]> = [
    ["APPROVED", "APPROVED"],
    ["REJECTED", "REJECTED"],
    ["CANCELED", "CANCELED"],
    ["PENDING", "PENDING"],
    ["SOMETHING_NEW", "PENDING"],
  ];
  for (const [raw, expected] of cases) {
    const api = fakeApi({ widget: { id: "w1", type: "input" }, statuses: [raw] });
    const result = await makeClient(api).query("INST-9");
    assert.equal(result.status, expected, `飞书状态 ${raw} 应映射成 ${expected}`);
    assert.equal(result.instanceCode, "INST-9");
  }
});

test("query：PENDING 不是通过；空实例号 / 查询失败一律按在途", async () => {
  const pending = fakeApi({ widget: { id: "w1", type: "input" }, statuses: ["PENDING"] });
  const r1 = await makeClient(pending).query("INST-1");
  assert.equal(r1.status, "PENDING");
  assert.ok(!formatApprovalOutcome(r1).includes("可以按被授权的候选点落地"), "PENDING 不得放行");

  const empty = fakeApi({ widget: { id: "w1", type: "input" } });
  const r2 = await makeClient(empty).query("  ");
  assert.equal(r2.status, "PENDING");
  assert.equal(empty.calls.length, 0, "空实例号不该打接口");

  const broken = { async request() { throw new Error("boom"); } };
  const r3 = await makeClient(broken).query("INST-2");
  assert.equal(r3.status, "PENDING");
  assert.match(r3.detail ?? "", /查询审批状态失败/);
});

test("断档后续查：超时后拿同一实例号能查到 APPROVED，且不重发第二张单", async () => {
  let clock = 0;
  const statuses = ["PENDING", "PENDING"];
  const api = {
    calls: [] as Array<{ url: string; method: string; data?: any }>,
    async request(args: { url: string; method: string; data?: any }) {
      api.calls.push(args);
      if (args.method === "GET" && args.url.includes("/approvals/")) {
        return { data: { form: JSON.stringify({ widgets: [{ id: "w1", type: "input" }] }) } };
      }
      if (args.method === "POST") return { data: { instance_code: "INST-7" } };
      return { data: { status: statuses.length > 1 ? statuses.shift()! : statuses[0] } };
    },
  };
  const client = new LearnApprovalClient({
    api,
    config: { approvalCode: "AP-1", timeoutSec: 10, pollIntervalSec: 1 },
    sleep: async () => {
      clock += 4000;
    },
    now: () => clock,
    log: () => {},
  });

  const timedOut = await client.request({ body: "候选点 9", applicantOpenId: "ou_user" });
  assert.equal(timedOut.status, "TIMEOUT");
  assert.equal(timedOut.instanceCode, "INST-7");
  assert.equal(api.calls.filter((c) => c.method === "POST").length, 1, "超时不应重发");
  // 超时文案必须让人去「续查同一实例号」，而不是重发
  assert.ok(formatApprovalOutcome(timedOut).includes("不要重发"));

  statuses.length = 0;
  statuses.push("APPROVED");
  const again = await client.query(timedOut.instanceCode!);
  assert.equal(again.status, "APPROVED");
  assert.ok(formatApprovalOutcome(again).includes("可以按被授权的候选点落地"));
  assert.equal(api.calls.filter((c) => c.method === "POST").length, 1, "续查不能再建单");
});

test("提交文案：失败不放行；成功给实例号并禁止重复提交", () => {
  assert.match(formatSubmitOutcome({ ok: false, detail: "没配审批" }), /一个字都不要改/);
  const text = formatSubmitOutcome({ ok: true, instanceCode: "INST-3" });
  assert.match(text, /INST-3/);
  assert.match(text, /不要重复提交/);
});
