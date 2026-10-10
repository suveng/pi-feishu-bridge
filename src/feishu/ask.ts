/**
 * 飞书「选择题」卡片：把模型要问用户的选项渲染成按钮，点一下即作答。
 *
 * 背景：模型在飞书里问「1A 2A 3A 这种格式回我」体验很差。桥接提供 feishu_ask 工具，
 * 模型调用后这里渲染一张交互卡片，按钮回调走 card.action.trigger，
 * 全部答完后把结果作为工具返回值交回模型。
 *
 * 待答状态放模块级单例：工具实例（会话内）与卡片回调（daemon 主会话）在同一个
 * Node 进程、同一份模块图里，因此可以直接共享。
 */
import { debugLog } from "./debug.ts";

/**
 * 选项：label 要短（按钮上显示，用业务词），description 写这道选项的好处与坏处
 * （各一句，卡片正文显示）。非技术类需求一律业务语言，不带 proto 字段名 / 表名 / 函数名。
 */
export type AskOption = {
  label: string;
  description?: string;
};

export type AskQuestion = {
  /** 短标题，如「货币范围」 */
  header: string;
  /** 完整问题 */
  question: string;
  /** 2-4 个选项 */
  options: AskOption[];
};

export type AskAnswer = {
  header: string;
  question: string;
  /** 用户选了哪个 label；undefined = 未作答 */
  chosen?: string;
};

export type AskOutcome = {
  answers: AskAnswer[];
  /** true = 等超时了，answers 里可能有未作答项 */
  timedOut: boolean;
  /**
   * true = 本次提问被主动取消（停止按钮 / 新一轮打断）。
   * 此时整轮已经作废，调用方不能再去「开新段继续写」。
   */
  canceled?: boolean;
  /**
   * true = 选择题卡片根本没发出去（飞书接口报错/读超时）。
   * 绝不能当成「用户没选」：用户根本没看到这道题。
   */
  sendFailed?: boolean;
};

/** 图上已经答完的旧问题，附到下一张选择题卡顶部，别让答过的内容凭空消失 */
export type AskHistoryEntry = {
  question: string;
  chosen?: string;
};

type AskRecord = {
  askId: string;
  key: string;
  questions: AskQuestion[];
  answers: (string | undefined)[];
  resolve: (outcome: AskOutcome) => void;
  timer?: NodeJS.Timeout;
  /** 提问卡片的消息 ID；超时后原地刷新同一张卡时用 */
  cardMessageId?: string;
};

/** 提问的终态：答完 / 超时 / 被取消 */
export type AskSettleStatus = "done" | "timeout" | "canceled";

/** 已结算的提问记录，用于给「迟到的点击」一个明确答复 */
type SettledAsk = { record: AskRecord; status: AskSettleStatus };

/** 等用户点击的最长时间；超时后把已答部分交回模型，避免整轮卡死 */
export const ASK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 已结算记录的保留时长。
 * 超时后用户往往还会再点几下，这段时间内必须还能回答他「这个提问已经结束了」，
 * 否则卡片上的按钮看起来能用、点下去却毫无反应（僵尸卡片）。
 */
const SETTLED_TTL_MS = 30 * 60 * 1000;
/** 按钮上文字的最大长度（飞书 plain_text 有长度限制） */
const BUTTON_LABEL_MAX = 20;
/** 自由输入答案的最大长度，防止误粘贴超长文本把卡片撞坏 */
const CUSTOM_ANSWER_MAX = 200;

const pendingAsks = new Map<string, AskRecord>();
const settledAsks = new Map<string, SettledAsk>();

/** 登记一次已结算的提问，并安排过期回收（定时器不拖住进程退出） */
function rememberSettled(record: AskRecord, status: AskSettleStatus) {
  settledAsks.set(record.askId, { record, status });
  const timer = setTimeout(() => settledAsks.delete(record.askId), SETTLED_TTL_MS);
  timer.unref?.();
}

/** 表单容器里输入框的 name；回调的 form_value 用它取值，必须与渲染时一致 */
export function askInputName(questionIndex: number) {
  return `ask_input_${questionIndex}`;
}

/** 答案不在选项里 = 用户自己敲的（自由输入） */
function isCustomAnswer(question: AskQuestion, chosen: string) {
  return !question.options.some((option) => option.label === chosen);
}

/** 按子问题字母序号（A/B/C…），与卡片正文里列的编号一致 */
function optionLetter(index: number) {
  return String.fromCharCode(65 + index);
}

function truncateLabel(label: string) {
  const text = label.trim();
  return text.length > BUTTON_LABEL_MAX ? `${text.slice(0, BUTTON_LABEL_MAX - 1)}…` : text;
}

/** 一张选择题卡上最多展示几条已答记录（编号仍按真实序号，不跳号） */
const HISTORY_MAX = 4;

export function buildAskCard(
  askId: string,
  questions: AskQuestion[],
  answers: (string | undefined)[],
  status: "pending" | "done" | "timeout" | "canceled" = "pending",
  history: AskHistoryEntry[] = [],
) {
  const elements: any[] = [];

  // 同一轮里第 2 次提问会复用同一张卡：已答的旧问题单独成块列在上面，
  // 新问题接着旧编号往下编（否则第 2 题又写成「1.」，看起来像顺序错乱）
  if (history.length) {
    const shown = history.slice(-HISTORY_MAX);
    const offset = history.length - shown.length;
    const lines = shown.map(
      (entry, index) => `${offset + index + 1}. ${entry.question} → ${entry.chosen ?? "（未选）"}`,
    );
    elements.push({ tag: "markdown", content: `**已答：**\n${lines.join("\n")}` });
    elements.push({ tag: "hr" });
  }

  questions.forEach((question, questionIndex) => {
    const chosen = answers[questionIndex];
    // 展示编号接着已答记录往下数；按钮回调用的是 questionIndex（0 基），与展示无关
    const displayNumber = history.length + questionIndex + 1;
    const lines: string[] = [`**${displayNumber}. ${question.question}**`];
    question.options.forEach((option, optionIndex) => {
      const desc = option.description ? ` — ${option.description}` : "";
      const mark = chosen === option.label ? " ✅" : "";
      lines.push(`${optionLetter(optionIndex)}. ${option.label}${desc}${mark}`);
    });
    // 自由输入的答案不在选项列表里，单独标一行，否则用户看不出自己答了什么
    if (chosen && isCustomAnswer(question, chosen)) {
      lines.push(`✏️ 你的输入：${chosen}`);
    }
    elements.push({ tag: "markdown", content: lines.join("\n") });

    // 已经答过的问题不再给按钮和输入框，避免重复提交
    if (chosen) return;
    elements.push({
      tag: "action",
      actions: question.options.slice(0, 4).map((option) => ({
        tag: "button",
        text: { tag: "plain_text", content: truncateLabel(`${optionLetter(question.options.indexOf(option))}. ${option.label}`) },
        type: "default",
        value: {
          action: "pi_feishu_ask_answer",
          askId,
          questionIndex,
          label: option.label,
        },
      })),
    });

    // 自由输入：表单容器 + 输入框 + 提交按钮。
    // 飞书规定表单内交互组件必须带全局唯一的 name，且容器内至少要有一个 submit 按钮；
    // 提交回调的 action.tag 仍是 button，值在 action.form_value 里。
    elements.push({
      tag: "form",
      name: `ask_form_${questionIndex}`,
      elements: [
        {
          tag: "input",
          name: askInputName(questionIndex),
          placeholder: { tag: "plain_text", content: "选项都不合适？在这里自己输入，再点「提交输入」" },
        },
        {
          tag: "button",
          // 飞书要求 form 容器内的**每个**交互组件都带 name（含提交按钮），
          // 缺了会整张卡片被拒：230099 / 200530 "the interactive element in the form container must have a name"
          name: `ask_submit_${questionIndex}`,
          text: { tag: "plain_text", content: "提交输入" },
          type: "primary",
          action_type: "form_submit",
          value: {
            action: "pi_feishu_ask_input",
            askId,
            questionIndex,
          },
        },
      ],
    });
  });

  const answeredCount = answers.filter(Boolean).length;
  const footer = status === "done"
    ? `✅ 已全部作答（${answeredCount}/${questions.length}）`
    : status === "timeout"
      ? `⌛ 等待超时，已作答 ${answeredCount}/${questions.length}`
      : status === "canceled"
        ? `⚠️ 提问已结束，已作答 ${answeredCount}/${questions.length}`
        : `等待选择（${answeredCount}/${questions.length}）`;
  elements.push({ tag: "markdown", content: footer });

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: status === "done" ? "green" : status === "pending" ? "turquoise" : "grey",
      title: {
        tag: "plain_text",
        content: status === "done"
          ? "已选择"
          : status === "timeout"
            ? "选择超时"
            : status === "canceled"
              ? "已结束"
              : "请选择",
      },
    },
    elements,
  };
}

/** 超时钩子：让调用方能在超时后把卡片原地刷成「已超时」 */
export type AskHooks = {
  onTimeout?: (record: AskRecord) => void;
};

/** 登记一次提问，返回 askId；超时自动结算 */
export function registerAsk(
  key: string,
  questions: AskQuestion[],
  resolve: (outcome: AskOutcome) => void,
  hooks: AskHooks = {},
): AskRecord {
  const askId = `ask_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const record: AskRecord = {
    askId,
    key,
    questions,
    answers: questions.map(() => undefined),
    resolve,
  };
  record.timer = setTimeout(() => {
    const current = pendingAsks.get(askId);
    if (!current) return;
    pendingAsks.delete(askId);
    debugLog("feishu.ask.timeout", { askId, key, answered: current.answers.filter(Boolean).length });
    rememberSettled(current, "timeout");
    try {
      hooks.onTimeout?.(current);
    } catch (error) {
      debugLog("feishu.ask.timeout_hook_failed", {
        askId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    current.resolve(toOutcome(current, { timedOut: true }));
  }, ASK_TIMEOUT_MS);
  // 定时器不该拖住进程退出
  record.timer.unref?.();
  pendingAsks.set(askId, record);
  return record;
}

export function getAsk(askId: string): AskRecord | undefined {
  return pendingAsks.get(askId);
}

/** 由发送方回填卡片消息 ID，超时刷新卡片时需要它 */
export function setAskCardMessage(askId: string, messageId: string) {
  const record = pendingAsks.get(askId);
  if (record) record.cardMessageId = messageId;
}

export type AskAnswerResult = {
  found: boolean;
  /** 本次是否让该问题从「未答」变成「已答」 */
  accepted: boolean;
  allAnswered: boolean;
  /** true = 该提问已结算（答完 / 超时 / 取消），本次点击不生效 */
  settled?: boolean;
  /** 已结算时的终态 */
  settledStatus?: AskSettleStatus;
  record?: AskRecord;
};

/** 记录一次按钮点击；返回是否已全部答完 */
export function answerAsk(
  askId: string,
  questionIndex: number,
  label: string,
  allowCustom = false,
): AskAnswerResult {
  const record = pendingAsks.get(askId);
  if (!record) {
    // 没有待答记录有两种可能：这个 askId 从来不存在（伪造回调），或者它已经结算了。
    // 后者必须回一个明确的终态，否则调用方只能静默丢弃，用户看到的是「点了没反应」。
    const settled = settledAsks.get(askId);
    if (!settled) return { found: false, accepted: false, allAnswered: false };
    return {
      found: true,
      accepted: false,
      allAnswered: false,
      settled: true,
      settledStatus: settled.status,
      record: settled.record,
    };
  }
  const question = record.questions[questionIndex];
  if (!question) return { found: true, accepted: false, allAnswered: false, record };
  // 自由输入的文本不在选项里，只有调用方声明「来自输入框」时才放行；
  // 其余情况仍要求命中选项，防止伪造回调值。
  const value = allowCustom ? label.trim().slice(0, CUSTOM_ANSWER_MAX) : label;
  if (!value) return { found: true, accepted: false, allAnswered: false, record };
  if (!allowCustom && !question.options.some((option) => option.label === value)) {
    return { found: true, accepted: false, allAnswered: false, record };
  }
  const accepted = !record.answers[questionIndex];
  record.answers[questionIndex] = value;
  const allAnswered = record.answers.every(Boolean);
  if (allAnswered) {
    pendingAsks.delete(askId);
    if (record.timer) clearTimeout(record.timer);
    rememberSettled(record, "done");
    debugLog("feishu.ask.answered", { askId, key: record.key, label: value, custom: allowCustom, allAnswered: true });
    record.resolve(toOutcome(record));
  } else {
    debugLog("feishu.ask.partial", {
      askId,
      key: record.key,
      questionIndex,
      label: value,
      custom: allowCustom,
      answered: record.answers.filter(Boolean).length,
    });
  }
  return { found: true, accepted, allAnswered, record };
}

/** 主动结束一次提问（例如整轮被停止）；未作答项保持 undefined */
export function cancelAsk(askId: string, timedOut = false) {
  const record = pendingAsks.get(askId);
  if (!record) return;
  pendingAsks.delete(askId);
  if (record.timer) clearTimeout(record.timer);
  rememberSettled(record, timedOut ? "timeout" : "canceled");
  record.resolve(toOutcome(record, timedOut ? { timedOut: true } : { canceled: true }));
}

/**
 * 提问卡片发送失败。
 *
 * 与 cancelAsk 的区别很重要：cancelAsk 是「用户没来得及答」，这里是「用户压根没收到」。
 * 不分开的话模型会把「未选择」当成用户的决定，接着按默认值往下答（表现为「秒超时」）。
 */
export function failAsk(askId: string) {
  const record = pendingAsks.get(askId);
  if (!record) return;
  pendingAsks.delete(askId);
  if (record.timer) clearTimeout(record.timer);
  rememberSettled(record, "canceled");
  record.resolve(toOutcome(record, { sendFailed: true }));
}

/**
 * 取消某个会话里所有待答提问（停止按钮 / 被新消息打断）。
 * 返回被取消的记录（含 cardMessageId），调用方拿它把卡片刷成「提问已结束」。
 *
 * 为什么要主动取消：`session.abort()` 不会解除 `feishu_ask` 的等待，那个 Promise
 * 会一直挂到 10 分钟超时，期间整轮无法真正收尾。
 */
export function cancelAskBySession(key: string, timedOut = false): AskRecord[] {
  const canceled: AskRecord[] = [];
  for (const [askId, record] of [...pendingAsks]) {
    if (record.key !== key) continue;
    cancelAsk(askId, timedOut);
    canceled.push(record);
  }
  return canceled;
}

function toOutcome(
  record: AskRecord,
  flags: { timedOut?: boolean; canceled?: boolean; sendFailed?: boolean } = {},
): AskOutcome {
  return {
    timedOut: Boolean(flags.timedOut),
    ...(flags.canceled ? { canceled: true } : {}),
    ...(flags.sendFailed ? { sendFailed: true } : {}),
    answers: record.questions.map((question, index) => ({
      header: question.header,
      question: question.question,
      chosen: record.answers[index],
    })),
  };
}
