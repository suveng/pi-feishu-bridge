/**
 * feishu_ask 选择题卡片的结算与「迟到点击」处理。
 *
 * 回归背景：超时/答完后再点同一张卡，旧实现是「静默丢弃」——卡片不刷新、
 * 也没有任何提示，用户看到的是点了没反应的僵尸卡片。这里把那条路径钉住。
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import {
  ASK_TIMEOUT_MS,
  answerAsk,
  buildAskCard,
  cancelAsk,
  cancelAskBySession,
  failAsk,
  getAsk,
  registerAsk,
  setAskCardMessage,
  type AskQuestion,
} from "../src/feishu/ask.ts";

function twoQuestions(): AskQuestion[] {
  return [
    {
      header: "第一步",
      question: "先做哪个？",
      options: [
        { label: "推进开发", description: "接着出技术方案" },
        { label: "先停在这", description: "等你确认" },
      ],
    },
    {
      header: "第二步",
      question: "范围多大？",
      options: [
        { label: "全量推进" },
        { label: "只出设计" },
      ],
    },
  ];
}

/** 取卡片里所有 markdown 文本，便于断言 footer / 选项标记 */
function cardText(card: ReturnType<typeof buildAskCard>): string {
  return (card.elements as any[])
    .filter((element) => element.tag === "markdown")
    .map((element) => element.content)
    .join("\n");
}

test("答完全部问题后，结算状态为 done", () => {
  let outcome;
  const record = registerAsk("group:test", twoQuestions(), (value) => {
    outcome = value;
  });

  const first = answerAsk(record.askId, 0, "推进开发");
  assert.equal(first.allAnswered, false, "只答一题不算结束");
  assert.equal(first.settled, undefined, "还在等答案时不该被判为已结算");

  const second = answerAsk(record.askId, 1, "全量推进");
  assert.equal(second.allAnswered, true);
  assert.equal((outcome as any).timedOut, false);
  assert.deepEqual(
    (outcome as any).answers.map((answer: any) => answer.chosen),
    ["推进开发", "全量推进"],
  );
});

test("答完后再点同一张卡：返回已结算（done），且不覆盖已记录的答案", () => {
  let outcome;
  const record = registerAsk("group:test", twoQuestions(), (value) => {
    outcome = value;
  });
  answerAsk(record.askId, 0, "推进开发");
  answerAsk(record.askId, 1, "全量推进");

  const late = answerAsk(record.askId, 0, "先停在这");
  assert.equal(late.found, true, "已结算的提问必须被认得，否则只能静默丢弃");
  assert.equal(late.settled, true);
  assert.equal(late.settledStatus, "done");
  assert.equal(late.accepted, false);
  assert.deepEqual(
    (outcome as any).answers.map((answer: any) => answer.chosen),
    ["推进开发", "全量推进"],
    "迟到点击不得改写原答案",
  );
});

test("超时：调用 onTimeout 钩子并带上卡片消息 ID，迟到点击得到 timeout 终态", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  const seen: { askId: string; cardMessageId?: string; answered: number }[] = [];
  let outcome;
  const record = registerAsk(
    "group:test",
    twoQuestions(),
    (value) => {
      outcome = value;
    },
    {
      onTimeout: (settled) => {
        seen.push({
          askId: settled.askId,
          cardMessageId: settled.cardMessageId,
          answered: settled.answers.filter(Boolean).length,
        });
      },
    },
  );
  setAskCardMessage(record.askId, "om_card_button");
  answerAsk(record.askId, 1, "全量推进");

  mock.timers.tick(ASK_TIMEOUT_MS);

  assert.equal(seen.length, 1, "超时必须触发一次卡片刷新钩子");
  assert.equal(seen[0].askId, record.askId);
  assert.equal(seen[0].cardMessageId, "om_card_button");
  assert.equal(seen[0].answered, 1, "钩子要拿到已答部分");
  assert.equal((outcome as any).timedOut, true);
  assert.deepEqual(
    (outcome as any).answers.map((answer: any) => answer.chosen),
    [undefined, "全量推进"],
  );

  const late = answerAsk(record.askId, 0, "推进开发");
  assert.equal(late.settled, true);
  assert.equal(late.settledStatus, "timeout", "超时后的点击必须报 timeout，才能给用户提示");
  assert.equal(late.accepted, false);
});

test("cancelAsk 后点击：终态为 canceled（区别于超时）", () => {
  let outcome;
  const record = registerAsk("group:test", twoQuestions(), (value) => {
    outcome = value;
  });
  cancelAsk(record.askId);

  assert.equal((outcome as any).timedOut, false);
  const late = answerAsk(record.askId, 0, "推进开发");
  assert.equal(late.settled, true);
  assert.equal(late.settledStatus, "canceled");
});

test("完全没见过的 askId：found=false（伪造回调不产生任何终态）", () => {
  const result = answerAsk("ask_不存在", 0, "推进开发");
  assert.equal(result.found, false);
  assert.equal(result.settled, undefined);
});

test("自由输入只在 allowCustom 时被接受，且不在选项里也能记下", () => {
  let outcome;
  const record = registerAsk("group:test", twoQuestions(), (value) => {
    outcome = value;
  });

  const rejected = answerAsk(record.askId, 0, "手敲的答案");
  assert.equal(rejected.accepted, false, "伪造的选项值必须被拒");
  assert.equal(rejected.settled, undefined);

  const accepted = answerAsk(record.askId, 0, "手敲的答案", true);
  assert.equal(accepted.accepted, true);
  answerAsk(record.askId, 1, "只出设计");
  assert.equal((outcome as any).answers[0].chosen, "手敲的答案");
});

test("buildAskCard：done / timeout / canceled 三态文案与颜色区分明确", () => {
  const questions = twoQuestions();
  const answers = ["推进开发", undefined];

  const pending = buildAskCard("ask_1", questions, answers, "pending");
  assert.equal(pending.header.title.content, "请选择");
  assert.equal(pending.header.template, "turquoise");
  assert.match(cardText(pending), /等待选择（1\/2）/);

  const done = buildAskCard("ask_1", questions, ["推进开发", "全量推进"], "done");
  assert.equal(done.header.title.content, "已选择");
  assert.equal(done.header.template, "green");
  assert.match(cardText(done), /✅ 已全部作答（2\/2）/);

  const timeout = buildAskCard("ask_1", questions, answers, "timeout");
  assert.equal(timeout.header.title.content, "选择超时");
  assert.equal(timeout.header.template, "grey");
  assert.match(cardText(timeout), /⌛ 等待超时，已作答 1\/2/);

  const canceled = buildAskCard("ask_1", questions, answers, "canceled");
  assert.equal(canceled.header.title.content, "已结束");
  assert.equal(canceled.header.template, "grey");
  assert.match(cardText(canceled), /⚠️ 提问已结束，已作答 1\/2/);
});

test("buildAskCard：已答过的问题不再给按钮（防重复提交）", () => {
  const card = buildAskCard("ask_1", twoQuestions(), ["推进开发", undefined], "pending");
  const actionRows = (card.elements as any[]).filter((element) => element.tag === "action");
  assert.equal(actionRows.length, 1, "只该剩第二题的按钮行");
  assert.equal(actionRows[0].actions[0].value.questionIndex, 1);
});

test("buildAskCard：同轮第二次提问复用同一张卡，旧问题以删除线保留在顶部", () => {
  const card = buildAskCard("ask_2", twoQuestions(), [undefined, undefined], "pending", [
    { question: "先做哪个？", chosen: "推进开发" },
  ]);
  const text = cardText(card);
  assert.match(text, /先做哪个？/, "答过的旧问题不能凭空消失");
  assert.match(text, /推进开发/);
  assert.match(text, /~~先做哪个？~~/, "旧问题用删除线标成已答");
});

test("cancelAskBySession：只取消该会话的提问，并标记 canceled", () => {
  let outcomeA: any;
  let outcomeB: any;
  const recordA = registerAsk("group:a", twoQuestions(), (value) => {
    outcomeA = value;
  });
  const recordB = registerAsk("group:b", twoQuestions(), (value) => {
    outcomeB = value;
  });

  const canceled = cancelAskBySession("group:a");
  assert.equal(canceled.length, 1, "只该取消 group:a 的那一条");
  assert.equal(canceled[0].askId, recordA.askId);
  assert.equal(outcomeA.canceled, true, "被取消的提问必须带 canceled 标记（调用方据此不开新卡）");
  assert.equal(outcomeA.timedOut, false);
  assert.equal(outcomeB, undefined, "别的会话不受影响");

  cancelAsk(recordB.askId);
  assert.equal(outcomeB.canceled, true);
});

test("正常作答不带 canceled 标记（否则整轮会被当成已作废）", () => {
  let outcome: any;
  const record = registerAsk("group:test", twoQuestions(), (value) => {
    outcome = value;
  });
  answerAsk(record.askId, 0, "推进开发");
  answerAsk(record.askId, 1, "全量推进");
  assert.equal(outcome.canceled, undefined);
  assert.equal(outcome.timedOut, false);
});

test("卡片发送失败走 sendFailed，不能报成「用户没选」", () => {
  let outcome: any;
  const record = registerAsk("group:test", twoQuestions(), (value) => {
    outcome = value;
  });
  setAskCardMessage(record.askId, "om_card_1");

  failAsk(record.askId);

  assert.equal(outcome.sendFailed, true, "发送失败必须单独标记，否则模型会把未选择当成用户的决定");
  assert.equal(outcome.canceled, undefined);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.answers.every((answer: any) => answer.chosen === undefined), true);
  // 卡片没发出去，不能在超时/取消路径上再刷一张不存在的卡
  assert.equal(getAsk(record.askId), undefined, "已结算的提问不能再被点击影响");
});
