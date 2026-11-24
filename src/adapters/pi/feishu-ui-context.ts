/**
 * 飞书 UI 上下文：把 pi 扩展的 `ctx.ui.select / input / confirm / notify` 接到飞书交互卡片。
 *
 * 背景：pi 的提问类扩展（如 rpiv-ask-user-question）在 RPC 宿主下不走 TUI，而是调用
 * `ctx.ui.select()` / `ctx.ui.input()` 这套对话框原语（见其 rpc-fallback.ts）。桥接以前
 * `bindExtensions({})` 不传 uiContext，这些原语落到 noOpUIContext（select 恒返回 undefined），
 * 扩展只能退回纯文本「回复 1A 2A」。这里实现一套真正的 uiContext：每个对话框原语都渲染成
 * 一张飞书卡片（复用 feishu/ask.ts 的按钮 + 自由输入表单），用户点选 / 输入后把结果交回扩展。
 *
 * 关键契约（与 rpiv rpc-fallback.ts 的 walker 对齐）：
 * - walker 把选项格式化成行 `1. label — description`，单选末尾再追加一行 sentinel
 *   `N+1. Type something.`。select 收到的 `options` 就是这些**整行**。
 * - walker 解析返回值顺序：① 整行 indexOf ② 纯数字 ③ 裸 label ④ 都不中 → 当成自定义答案。
 *   因此本实现**点按钮时返回对应的原始整行**（命中①，最稳）；用户在表单自由输入时返回
 *   输入文本（命中④，等效「Type something」少一轮卡片）。sentinel 行也渲染成按钮，点它
 *   返回 sentinel 整行 → walker 自动转 input，无需在此识别 sentinel 文案。
 * - select / input 返回 undefined = 用户取消（整轮被停止 / 打断 / 卡片发送失败）。
 *
 * 其余 TUI 专用方法（setWidget / custom / editor / theme …）在飞书里没有对应物，一律 no-op，
 * 与 pi 内置 noOpUIContext 同形，保证扩展调用任何 ui 方法都不抛错。
 */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AskOutcome, AskQuestion } from "../../feishu/ask.ts";
import { debugLog } from "../../feishu/debug.ts";

export type FeishuUiDeps = {
  /** 发起提问的会话 key：卡片只发回这个会话，避免私聊/群聊并发串台 */
  sessionKey: string;
  /** 复用 PiConversationRuntime.askUser：含暂停流式卡 / 等点击 / 收尾恢复的完整临界区 */
  askUser: (key: string, questions: AskQuestion[]) => Promise<AskOutcome>;
  /** 复用 PiConversationRuntime.pushUiNotify：notify 文本路由到当前飞书轮次 */
  pushUiNotify: (text: string) => void;
};

/** walker 选项行的分隔符（em dash 两侧空格），与 formatOptionLine 一致 */
const OPTION_SEP = " — ";

/** 把 walker 的整行 `1. label — description` 拆回 label / description，保留原始整行用于回传 */
function parseOptionLine(line: string): { label: string; description?: string; line: string } {
  const stripped = line.replace(/^\s*\d+\.\s*/, "");
  const sep = stripped.indexOf(OPTION_SEP);
  if (sep >= 0) {
    return {
      label: stripped.slice(0, sep).trim(),
      description: stripped.slice(sep + OPTION_SEP.length).trim() || undefined,
      line,
    };
  }
  return { label: stripped.trim(), line };
}

/** 从 walker 标题 `[header] question` 里取短标题；取不到就截前 16 字 */
function deriveHeader(title: string): string {
  const matched = title.match(/^\[([^\]]+)\]/);
  if (matched) return matched[1].slice(0, 16);
  return title.slice(0, 16);
}

/** 取消 / 发送失败 / 超时 → 没有有效作答；否则取第一题的 chosen */
function firstChosen(outcome: AskOutcome): string | undefined {
  if (outcome.canceled || outcome.sendFailed || outcome.timedOut) return undefined;
  return outcome.answers[0]?.chosen;
}

/**
 * 构造飞书 uiContext。select / input / confirm 都走 askUser 卡片，notify 走轮次通知缓冲，
 * 其余 TUI 方法 no-op。返回对象可直接传给 `session.bindExtensions({ uiContext, mode: "rpc" })`。
 */
export function createFeishuUiContext(deps: FeishuUiDeps): ExtensionUIContext {
  /** 单题卡片：把一道 AskQuestion 发出去并等用户作答，返回 chosen（取消则 undefined） */
  const askOne = async (question: AskQuestion): Promise<string | undefined> => {
    const outcome = await deps.askUser(deps.sessionKey, [question]);
    const chosen = firstChosen(outcome);
    debugLog("feishu.ui.dialog_settled", {
      key: deps.sessionKey,
      header: question.header,
      canceled: Boolean(outcome.canceled),
      sendFailed: Boolean(outcome.sendFailed),
      answered: chosen !== undefined,
    });
    return chosen;
  };

  const ui: ExtensionUIContext = {
    // 选择题：options 是 walker 的整行；点按钮回传原始整行，自由输入回传文本
    select: async (title, options) => {
      if (!options?.length) return undefined;
      const parsed = options.map(parseOptionLine);
      const chosen = await askOne({
        header: deriveHeader(title),
        question: title,
        options: parsed.map((item) => ({ label: item.label, description: item.description })),
      });
      if (chosen === undefined) return undefined;
      // 命中某个选项 → 回传它的原始整行（walker ① indexOf 匹配）；否则是自由输入 → 原样回传（walker ④）
      const matched = parsed.find((item) => item.label === chosen);
      return matched ? matched.line : chosen;
    },

    // 纯文本输入：空 options 的卡片只渲染问题 + 自由输入表单
    input: async (title) => {
      return askOne({ header: deriveHeader(title), question: title, options: [] });
    },

    // 确认：两按钮「确认 / 取消」，返回布尔
    confirm: async (title, message) => {
      const yes = "确认";
      const chosen = await askOne({
        header: deriveHeader(title),
        question: message ? `${title}\n${message}` : title,
        options: [{ label: yes }, { label: "取消" }],
      });
      return chosen === yes;
    },

    // 通知：路由到当前飞书轮次的通知缓冲（与扩展 emit 的 notify 同一条路）
    notify: (message) => {
      deps.pushUiNotify(message);
    },

    // —— 以下均为 TUI 专用能力，飞书无对应物，no-op（与 pi noOpUIContext 同形）——
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined as never,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: undefined as never,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "飞书会话不支持切换主题" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
  return ui;
}