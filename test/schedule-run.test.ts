import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeishuScheduleService } from "../src/feishu/schedule-service.ts";
import { ScheduleStore } from "../src/feishu/schedule-store.ts";
import { FeishuScheduler, scheduleSessionKey } from "../src/feishu/scheduler.ts";
import type { ConversationRuntime } from "../src/feishu/runtime.ts";
import type { FeishuTransport } from "../src/feishu/transport.ts";
import type { FeishuMessage } from "../src/feishu/types.ts";

const NOW = new Date(2026, 10, 22, 10, 30, 0).getTime();

type Recorded = {
  created: Array<{ chatId: string; card: any }>;
  updated: Array<{ messageId: string; card: any }>;
  texts: string[];
  prompts: Array<{ key: string; text: string }>;
  newSessions: string[];
  routes: Array<{ key: string; chatId: string }>;
};

function makeHarness(overrides: { now?: () => number; reply?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "feishu-sched-run-"));
  const store = new ScheduleStore(join(dir, "schedules.pi.json"));
  const recorded: Recorded = { created: [], updated: [], texts: [], prompts: [], newSessions: [], routes: [] };

  const transport = {
    isRunning: () => true,
    createCard: async (chatId: string, card: any) => {
      recorded.created.push({ chatId, card });
      return "om_card_1";
    },
    replyCard: async (messageId: string, card: any) => {
      recorded.created.push({ chatId: `reply:${messageId}`, card });
      return "om_reply_1";
    },
    updateCard: async (messageId: string, card: any) => {
      recorded.updated.push({ messageId, card });
      return true;
    },
    sendText: async (chatId: string, text: string) => {
      recorded.texts.push(`${chatId}|${text}`);
      return "om_text_1";
    },
    replyText: async (messageId: string, text: string) => {
      recorded.texts.push(`reply:${messageId}|${text}`);
      return "om_text_2";
    },
    requestApi: async () => ({ code: 0, data: { name: "测试群", chat_mode: "group" } }),
  } as unknown as FeishuTransport;

  const conversations = {
    newConversation: async (key: string) => {
      recorded.newSessions.push(key);
    },
    promptWithImages: async (key: string, text: string, _images: unknown, onReply: (r: string) => Promise<void>, _status: unknown, onDelta?: (d: string) => void) => {
      recorded.prompts.push({ key, text });
      onDelta?.("正在生成");
      await onReply(overrides.reply ?? "已完成今天的工作");
    },
    getStatus: () => ({ hasActiveRun: false, model: undefined, thinking: undefined }),
    getSelectedModel: async () => ({ provider: "test", id: "test-model" }),
  } as unknown as ConversationRuntime;

  const bridgeStore = {
    bindScheduledRoute: (key: string, target: { chatId: string }) => {
      recorded.routes.push({ key, chatId: target.chatId });
      return { sessionKey: key, ...target, lastMessageId: "", updatedAt: NOW };
    },
  } as any;

  const scheduler = new FeishuScheduler({
    store,
    conversations,
    getTransport: () => transport,
    getBridgeStore: () => bridgeStore,
    now: overrides.now ?? (() => NOW),
  });
  const service = new FeishuScheduleService({
    store,
    scheduler,
    getTransport: () => transport,
    now: overrides.now ?? (() => NOW),
  });

  return {
    dir,
    store,
    scheduler,
    service,
    recorded,
    transport,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function message(overrides: Partial<FeishuMessage> = {}): FeishuMessage {
  return {
    messageId: "om_user_msg",
    chatId: "oc_dm_or_group",
    chatType: "group",
    senderOpenId: "ou_user",
    msgType: "text",
    content: "",
    ...overrides,
  } as FeishuMessage;
}

test("到点触发：新建会话、流式卡片发到任务指定的会话、结果落盘", async () => {
  const h = makeHarness();
  try {
    const job = h.store.create({
      name: "每日日报",
      prompt: "生成昨日订单日报",
      kind: "once",
      at: NOW,
      timeLabel: "一次性",
      target: { chatId: "oc_target", chatType: "group" },
    });

    const due = await h.scheduler.tick();
    await h.scheduler.waitForIdle();

    assert.deepEqual(due, [job.id]);
    assert.equal(h.recorded.newSessions[0], scheduleSessionKey(job.id));
    assert.equal(h.recorded.created[0].chatId, "oc_target");
    assert.match(h.recorded.prompts[0].text, /每日日报/);
    assert.match(h.recorded.prompts[0].text, /生成昨日订单日报/);
    assert.equal(h.recorded.routes[0].chatId, "oc_target");
    assert.equal(h.store.get(job.id)!.lastStatus, "ok");
    assert.equal(h.store.get(job.id)!.runCount, 1);
  } finally {
    h.cleanup();
  }
});

test("还没到点的任务不会被触发", async () => {
  const h = makeHarness();
  try {
    h.store.create({
      name: "明天",
      prompt: "明天再说",
      kind: "once",
      at: NOW + 3_600_000,
      timeLabel: "一次性",
      target: { chatId: "oc_target", chatType: "group" },
    });
    assert.deepEqual(await h.scheduler.tick(), []);
    await h.scheduler.waitForIdle();
    assert.equal(h.recorded.prompts.length, 0);
  } finally {
    h.cleanup();
  }
});

test("暂停的任务不触发；桥接没连上时不消耗触发（恢复后补跑）", async () => {
  const h = makeHarness();
  try {
    const job = h.store.create({
      name: "暂停的",
      prompt: "不该跑",
      kind: "once",
      at: NOW,
      timeLabel: "一次性",
      target: { chatId: "oc_target", chatType: "group" },
    });
    h.store.update(job.id, { enabled: false });
    assert.deepEqual(await h.scheduler.tick(), []);
    await h.scheduler.waitForIdle();
    assert.equal(h.recorded.prompts.length, 0);

    h.store.update(job.id, { enabled: true });
    const offline = new FeishuScheduler({
      store: h.store,
      conversations: { promptWithImages: async () => undefined } as any,
      getTransport: () => ({ isRunning: () => false } as any),
      now: () => NOW,
    });
    assert.deepEqual(await offline.tick(), [job.id]);
    await offline.waitForIdle();
    assert.equal(h.store.get(job.id)!.runCount, 0, "没连上飞书时不能算跑过，否则恢复后就不再补跑");
  } finally {
    h.cleanup();
  }
});

test("错过很久的任务只补一次，并在提示词里标注补跑", async () => {
  const late = NOW + 8 * 3_600_000;
  const h = makeHarness({ now: () => late });
  try {
    const job = h.store.create({
      name: "每小时巡检",
      prompt: "检查测服",
      kind: "every",
      everyMs: 3_600_000,
      timeLabel: "每 1 小时",
      target: { chatId: "oc_target", chatType: "group" },
    });
    // 把创建时间挪到 2.5 小时前，模拟机器睡了一晚、现在已错过一个格点
    h.store.update(job.id, { createdAt: late - 2.5 * 3_600_000, lastRunAt: late - 2.5 * 3_600_000 });

    const due = await h.scheduler.tick();
    await h.scheduler.waitForIdle();
    assert.deepEqual(due, [job.id]);
    assert.equal(h.recorded.prompts.length, 1, "只补一次，不补多条");
    assert.match(h.recorded.prompts[0].text, /补跑/);
    assert.equal(h.store.get(job.id)!.runCount, 1);
  } finally {
    h.cleanup();
  }
});

test("/sched 一句话建任务：时间与内容用 | 分开，通知落在当前会话", async () => {
  const h = makeHarness();
  try {
    const handled = await h.service.handleCommand(message({ chatId: "oc_here" }), "每天 9:00 | 生成日报");
    assert.equal(handled, true);
    const jobs = h.store.list();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].name, "生成日报");
    assert.equal(jobs[0].timeLabel, "每天 09:00");
    assert.equal(jobs[0].target.chatId, "oc_here");
    assert.equal(jobs[0].createdBy, "ou_user");
    assert.match(JSON.stringify(h.recorded.created[0].card), /生成日报/);
  } finally {
    h.cleanup();
  }
});

test("/sched 一句话建任务：不用 | 也能切出时间（取最长可解析前缀）", async () => {
  const h = makeHarness();
  try {
    await h.service.handleCommand(message(), "每 2 小时 检查测服健康状态");
    const job = h.store.list()[0];
    assert.equal(job.kind, "every");
    assert.equal(job.everyMs, 7_200_000);
    assert.equal(job.prompt, "检查测服健康状态");
  } finally {
    h.cleanup();
  }
});

test("/sched 认不出时间时回提示，不建任务", async () => {
  const h = makeHarness();
  try {
    await h.service.handleCommand(message(), "随便什么时候 | 跑一下");
    assert.equal(h.store.list().length, 0);
    assert.match(h.recorded.texts[0], /时间/);
  } finally {
    h.cleanup();
  }
});

test("话题群里创建任务会把话题记进通知落点", async () => {
  const h = makeHarness();
  try {
    await h.service.handleCommand(
      message({ chatId: "oc_topic", chatMode: "topic", threadId: "om_thread_root" }),
      "每天 9:00 | 生成日报",
    );
    assert.equal(h.store.list()[0].target.threadMessageId, "om_thread_root");
  } finally {
    h.cleanup();
  }
});

test("点「改通知到这里」把落点换成当前会话", async () => {
  const h = makeHarness();
  try {
    const job = h.store.create({
      name: "日报",
      prompt: "生成日报",
      kind: "cron",
      cron: "0 9 * * *",
      timeLabel: "每天 09:00",
      target: { chatId: "oc_old", chatType: "group" },
    });
    const card = await h.service.handleAction({
      messageId: "om_card",
      chatId: "oc_new",
      operatorOpenId: "ou_user",
      value: { action: "pi_feishu_sched_notify", id: job.id },
    });
    assert.equal(h.store.get(job.id)!.target.chatId, "oc_new");
    assert.match(JSON.stringify(card), /改到本会话/);
  } finally {
    h.cleanup();
  }
});

test("删除要二次确认：第一次只出确认态，第二次才真删", async () => {
  const h = makeHarness();
  try {
    const job = h.store.create({
      name: "要删的",
      prompt: "跑",
      kind: "cron",
      cron: "0 9 * * *",
      timeLabel: "每天 09:00",
      target: { chatId: "oc_1", chatType: "group" },
    });

    await h.service.handleAction({
      messageId: "om_card",
      chatId: "oc_1",
      operatorOpenId: "ou_user",
      value: { action: "pi_feishu_sched_delete", id: job.id },
    });
    assert.ok(h.store.get(job.id), "第一次点击不能删");

    await h.service.handleAction({
      messageId: "om_card",
      chatId: "oc_1",
      operatorOpenId: "ou_user",
      value: { action: "pi_feishu_sched_delete", id: job.id, confirm: true },
    });
    assert.equal(h.store.get(job.id), undefined);
  } finally {
    h.cleanup();
  }
});

test("暂停 / 恢复按钮改的是 enabled", async () => {
  const h = makeHarness();
  try {
    const job = h.store.create({
      name: "日报",
      prompt: "跑",
      kind: "cron",
      cron: "0 9 * * *",
      timeLabel: "每天 09:00",
      target: { chatId: "oc_1", chatType: "group" },
    });
    await h.service.handleAction({
      messageId: "om_card",
      chatId: "oc_1",
      operatorOpenId: "ou_user",
      value: { action: "pi_feishu_sched_toggle", id: job.id },
    });
    assert.equal(h.store.get(job.id)!.enabled, false);
    await h.service.handleAction({
      messageId: "om_card",
      chatId: "oc_1",
      operatorOpenId: "ou_user",
      value: { action: "pi_feishu_sched_toggle", id: job.id },
    });
    assert.equal(h.store.get(job.id)!.enabled, true);
  } finally {
    h.cleanup();
  }
});

test("表单新建：时间/内容/名称都从 formValue 取，缺内容时报错不建", async () => {
  const h = makeHarness();
  try {
    await h.service.handleAction({
      messageId: "om_card",
      chatId: "oc_form",
      operatorOpenId: "ou_user",
      value: { action: "pi_feishu_sched_create" },
      formValue: { sched_name: "巡检", sched_time: "每 30 分钟", sched_prompt: "检查一次健康接口" },
    });
    const job = h.store.list()[0];
    assert.equal(job.name, "巡检");
    assert.equal(job.everyMs, 1_800_000);
    assert.equal(job.target.chatId, "oc_form");

    await h.service.handleAction({
      messageId: "om_card",
      chatId: "oc_form",
      operatorOpenId: "ou_user",
      value: { action: "pi_feishu_sched_create" },
      formValue: { sched_time: "每天 9:00", sched_prompt: "  " },
    });
    assert.equal(h.store.list().length, 1, "空内容不该建出任务");
  } finally {
    h.cleanup();
  }
});
