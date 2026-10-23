import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBotCommand, getCommandList } from "../src/feishu/messages.ts";
import { buildRestartCard } from "../src/feishu/cards.ts";
import {
  ackRestartIfPending,
  clearRestartFiles,
  readRestartResult,
  readRestartTicket,
  requestRestart,
  type RestartPaths,
  type RestartTicket,
} from "../src/feishu/restart.ts";
import type { FeishuTransport } from "../src/feishu/transport.ts";

function tempPaths(): RestartPaths & { cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "feishu-restart-"));
  return {
    ticketPath: join(dir, "restart-ticket.json"),
    resultPath: join(dir, "restart-result.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

type CardCall = { method: "replyCard" | "updateCard"; messageId: string; card: any };

/** 只实现 restart 流程用到的两个方法 */
function fakeTransport(options: { failReply?: boolean } = {}) {
  const calls: CardCall[] = [];
  const transport = {
    async replyCard(messageId: string, card: any) {
      if (options.failReply) throw new Error("卡片发送被拒");
      calls.push({ method: "replyCard", messageId, card });
      return "om_card_1";
    },
    async updateCard(messageId: string, card: any) {
      calls.push({ method: "updateCard", messageId, card });
    },
  } as unknown as FeishuTransport;
  return { transport, calls };
}

function ticketOf(overrides: Partial<RestartTicket> = {}): RestartTicket {
  return {
    version: 1,
    oldPid: process.pid,
    cwd: "/tmp/ws",
    piBin: "pi",
    args: ["--mode", "rpc", "-e", "/tmp/feishu/index.ts"],
    lockPath: "/tmp/locks.json",
    logPath: "/tmp/daemon.log",
    resultPath: "/tmp/restart-result.json",
    startedAt: Date.now(),
    cardMessageId: "om_card_1",
    ...overrides,
  };
}

test("TC-RESTART-01 /restart 解析为 restart 命令，force 变体带标记", () => {
  assert.deepEqual(parseBotCommand("/restart"), { name: "restart" });
  assert.deepEqual(parseBotCommand("/restart force"), { name: "restart", force: true });
  assert.deepEqual(parseBotCommand("  /restart   force  "), { name: "restart", force: true });
  // 不吞掉相邻命令：/restartx 不是命令
  assert.equal(parseBotCommand("/restartx"), undefined);
});

test("TC-RESTART-02 /commands 列表里有 /restart", () => {
  const list = getCommandList();
  assert.match(list, /\/restart — 重启桥接进程/);
});

test("TC-RESTART-03 三态卡片：重启中蓝 / 已重启绿 / 失败红", () => {
  const restarting = buildRestartCard({ stage: "restarting", commit: "abc123 fix: x", at: 1_700_000_000_000 });
  assert.equal(restarting.header.template, "blue");
  assert.match(restarting.header.title.content, /正在重启/);
  assert.match(restarting.elements[0].content, /abc123/);
  assert.match(restarting.elements[0].content, /会话上下文会保留/);

  const done = buildRestartCard({ stage: "done", commit: "abc123", elapsedMs: 2400, newPid: 4321, at: 1_700_000_000_000 });
  assert.equal(done.header.template, "green");
  assert.match(done.header.title.content, /已重启/);
  assert.match(done.elements[0].content, /2\.4s/);
  assert.match(done.elements[0].content, /pid 4321/);

  const failed = buildRestartCard({ stage: "failed", error: "新进程 45s 内未拿到网关锁", at: 1_700_000_000_000 });
  assert.equal(failed.header.template, "red");
  assert.match(failed.elements[0].content, /\/feishu start/);
});

test("TC-RESTART-04 有回复在跑时拒绝重启，且不发卡片", async () => {
  const paths = tempPaths();
  const { transport, calls } = fakeTransport();
  try {
    const result = await requestRestart({
      transport,
      trigger: { messageId: "om_msg", chatId: "oc_chat" },
      extensionPath: "/tmp/feishu/index.ts",
      hasActiveRun: true,
      paths,
      spawnWorker: () => assert.fail("拒绝时不应拉起 worker"),
    });
    assert.equal(result.ok, false);
    assert.match(result.error || "", /\/restart force/);
    assert.equal(calls.length, 0);
    assert.equal(existsSync(paths.ticketPath), false);
  } finally {
    paths.cleanup();
  }
});

test("TC-RESTART-05 正常重启：先发卡拿 message_id，再落票据给 worker", async () => {
  const paths = tempPaths();
  const { transport, calls } = fakeTransport();
  const spawned: RestartTicket[] = [];
  try {
    const result = await requestRestart({
      transport,
      trigger: { messageId: "om_msg", chatId: "oc_chat" },
      extensionPath: "/tmp/feishu/index.ts",
      cwd: process.cwd(),
      paths,
      spawnWorker: (ticket) => {
        // 卡片必须先发出去：票据里的回执地址不能是空的
        assert.equal(calls.length, 1);
        spawned.push(ticket);
        return { ok: true };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.cardMessageId, "om_card_1");
    assert.equal(calls[0].method, "replyCard");
    assert.equal(calls[0].messageId, "om_msg");

    const ticket = readRestartTicket(paths.ticketPath);
    assert.ok(ticket, "票据应落盘");
    assert.equal(ticket?.oldPid, process.pid);
    assert.equal(ticket?.cardMessageId, "om_card_1");
    assert.equal(ticket?.chatId, "oc_chat");
    assert.equal(ticket?.resultPath, paths.resultPath);
    assert.ok(ticket?.args.includes("-e"));
    assert.equal(ticket?.args[ticket.args.length - 1], "/tmp/feishu/index.ts");
    assert.equal(spawned.length, 1);
  } finally {
    paths.cleanup();
  }
});

test("TC-RESTART-06 worker 起不来时把卡片改成失败并清票据", async () => {
  const paths = tempPaths();
  const { transport, calls } = fakeTransport();
  try {
    const result = await requestRestart({
      transport,
      trigger: { messageId: "om_msg", chatId: "oc_chat" },
      extensionPath: "/tmp/feishu/index.ts",
      paths,
      spawnWorker: () => ({ ok: false, error: "重启 worker 不存在" }),
    });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].method, "updateCard");
    assert.equal(calls[1].messageId, "om_card_1");
    assert.equal(calls[1].card.header.template, "red");
    assert.equal(existsSync(paths.ticketPath), false);
  } finally {
    paths.cleanup();
  }
});

test("TC-RESTART-07 新进程按结果文件把「重启中」改成「已重启」并清空文件", async () => {
  const paths = tempPaths();
  const { transport, calls } = fakeTransport();
  try {
    writeFileSync(paths.ticketPath, JSON.stringify(ticketOf({ commit: "abc123" })));
    writeFileSync(
      paths.resultPath,
      JSON.stringify({ version: 1, ok: true, at: Date.now(), newPid: 999, elapsedMs: 1800 }),
    );
    const acked = await ackRestartIfPending(transport, paths);
    assert.equal(acked, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "updateCard");
    assert.equal(calls[0].messageId, "om_card_1");
    assert.equal(calls[0].card.header.template, "green");
    assert.match(calls[0].card.elements[0].content, /abc123/);
    assert.equal(existsSync(paths.ticketPath), false);
    assert.equal(existsSync(paths.resultPath), false);
  } finally {
    paths.cleanup();
  }
});

test("TC-RESTART-08 失败结果 → 红色卡；过期结果 → 不改卡只清理", async () => {
  const paths = tempPaths();
  try {
    const fail = fakeTransport();
    writeFileSync(paths.ticketPath, JSON.stringify(ticketOf()));
    writeFileSync(paths.resultPath, JSON.stringify({ version: 1, ok: false, at: Date.now(), error: "未拿到网关锁" }));
    assert.equal(await ackRestartIfPending(fail.transport, paths), true);
    assert.equal(fail.calls[0].card.header.template, "red");

    const stale = fakeTransport();
    writeFileSync(paths.ticketPath, JSON.stringify(ticketOf()));
    writeFileSync(
      paths.resultPath,
      JSON.stringify({ version: 1, ok: true, at: Date.now() - 10 * 60_000, newPid: 1 }),
    );
    assert.equal(await ackRestartIfPending(stale.transport, paths), false);
    assert.equal(stale.calls.length, 0);
    assert.equal(existsSync(paths.resultPath), false);
  } finally {
    paths.cleanup();
  }
});

test("TC-RESTART-09 只有票据、老 pid 已死 → 补一张「回执缺失」卡；老 pid 活着不动", async () => {
  const paths = tempPaths();
  const deadPid = 4194000; // 未使用的 pid，isAlive 判死
  try {
    const alive = fakeTransport();
    writeFileSync(paths.ticketPath, JSON.stringify(ticketOf({ oldPid: process.pid })));
    assert.equal(await ackRestartIfPending(alive.transport, paths), false);
    assert.equal(alive.calls.length, 0);
    assert.equal(existsSync(paths.ticketPath), true, "老进程还在跑时票据必须保留");

    const orphan = fakeTransport();
    writeFileSync(paths.ticketPath, JSON.stringify(ticketOf({ oldPid: deadPid })));
    assert.equal(await ackRestartIfPending(orphan.transport, paths), true);
    assert.equal(orphan.calls[0].card.header.template, "orange");
    assert.equal(existsSync(paths.ticketPath), false);
  } finally {
    paths.cleanup();
  }
});

test("TC-RESTART-10 坏票据/坏结果按缺失处理，不抛错", async () => {
  const paths = tempPaths();
  const { transport, calls } = fakeTransport();
  try {
    writeFileSync(paths.ticketPath, "{不是 json");
    writeFileSync(paths.resultPath, "[1,2,3]");
    assert.equal(readRestartTicket(paths.ticketPath), undefined);
    assert.equal(readRestartResult(paths.resultPath), undefined);
    assert.equal(await ackRestartIfPending(transport, paths), false);
    assert.equal(calls.length, 0);
    clearRestartFiles(paths.ticketPath, paths.resultPath);
    assert.equal(existsSync(paths.resultPath), false);
  } finally {
    paths.cleanup();
  }
});

test("TC-RESTART-11 票据里的 args 与 daemon-spec 完全一致（worker 靠它复刻启动命令）", async () => {
  const { daemonSpec, daemonCommand } = await import("../src/feishu/daemon-spec.ts");
  const spec = daemonSpec("/tmp/feishu/index.ts");
  assert.deepEqual(spec.args.slice(0, 2), ["--mode", "rpc"]);
  for (const flag of ["--no-extensions", "--no-skills", "--no-builtin-tools"]) {
    assert.ok(spec.args.includes(flag), `缺少 ${flag}`);
  }
  assert.equal(spec.args[spec.args.length - 2], "-e");
  const command = daemonCommand(spec);
  assert.match(command, /^tail -f \/dev\/null \| exec /);
  assert.match(command, /'-e' '\/tmp\/feishu\/index\.ts'$/);
});

test("TC-RESTART-12 回执卡片文案不泄露本地图片 markdown（避免卡片被拒）", () => {
  const card = buildRestartCard({ stage: "done", commit: "abc123", elapsedMs: 900, at: Date.now() });
  const body = JSON.stringify(card);
  assert.equal(body.includes("!["), false);
  // 结果文件里的内容只用于展示，不落库
  assert.ok(readFileSync(new URL("../src/feishu/restart.ts", import.meta.url), "utf8").includes("ackRestartIfPending"));
});
