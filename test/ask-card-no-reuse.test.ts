/**
 * 同一轮里第二次选择题必须平铺新卡，不得原地改写第一张。
 *
 * 回归背景：第一次提问作答后会 resume 开出一段新回复卡，此时把第二次提问
 * update 回第一张旧卡，新问题就停在旧位置上、新回复卡又排在它下面 ——
 * 用户看到的是「选择题卡被盖住 / 顺序颠倒」，还会误点新回复卡上的停止按钮。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiConversationRuntime } from "../src/adapters/pi/PiConversationRuntime.ts";
import { cancelAskBySession, type AskQuestion } from "../src/feishu/ask.ts";

/** 构造一道最简选择题 */
function question(n: number): AskQuestion {
  return {
    header: `问题${n}`,
    question: `这是第 ${n} 个问题`,
    options: [{ label: "A" }, { label: "B" }],
  };
}

/** 让已排队的微任务先跑完，再断言 sender 是否被调用 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("pi runtime: 同一轮第二次提问平铺新卡，不改写旧卡", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "feishu-ask-card-"));
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    const runtime = new PiConversationRuntime(join(homeDir, "ws"));
    const key = "p2p:ou_test";
    const sentCards: unknown[] = [];
    let updateCount = 0;

    // 必须注入当前轮次的 run：只有 run 存在时，「复用旧卡」这条错路径才会被走到
    // （旧实现读 run.askCardMessageId），否则测试对回归无区分度。
    (runtime as any).activeRuns.set(key, { stopped: false, askHistory: [] });

    runtime.setAskSender(async (_key: string, card: object) => {
      sentCards.push(card);
      return `om_card_${sentCards.length}`;
    });
    runtime.setAskCardUpdater(async () => {
      updateCount += 1;
    });

    const askUser = (runtime as any).askUser.bind(runtime) as (
      sessionKey: string,
      questions: AskQuestion[],
    ) => Promise<unknown>;

    // 第一次提问：应发一张新卡
    const first = askUser(key, [question(1)]);
    await flush();
    assert.equal(sentCards.length, 1, "第一次提问应发一张新卡");
    cancelAskBySession(key);
    await first;

    // 第二次提问：必须再发一张新卡，不能 update 旧卡
    const second = askUser(key, [question(2)]);
    await flush();
    assert.equal(sentCards.length, 2, "第二次提问必须再发一张新卡");
    assert.equal(updateCount, 0, "不得原地改写旧卡");
    cancelAskBySession(key);
    await second;
  } finally {
    process.env.HOME = previousHome;
    rmSync(homeDir, { recursive: true, force: true });
  }
});
