/** 单卡 UI 纯函数：构建飞书 interactive / CardKit 卡片 JSON（无 IO） */
/**
 * 卡片状态。
 * - running：正在流式回复
 * - paused：已定格、等用户在选择题卡片上作答（feishu_ask 等待期间）
 * - answered：用户已作答，这张卡已「翻页」，后续内容在新的一张卡上
 * - done/failed/stopped/inactive：终态
 */
export type ReplyCardStatus = "running" | "paused" | "answered" | "done" | "failed" | "stopped" | "inactive";

/** 只能作为终态写入的状态（paused 是中间态，不能被 finish 成 paused） */
export type ReplyCardFinalStatus = "done" | "failed" | "stopped";

export const STOP_ACTION = "pi_feishu_stop_task";
const MAX_NOTE_CHARS = 96;
const WAITING_TEXT = "正在回复…";
const PAUSED_TEXT = "（已暂停，等你在选择题卡片上作答）";

/** CardKit JSON 2.0 停止按钮（直接放在 elements 里，不用 1.0 的 action 模块） */
export function buildStopButton(key: string, runId?: string) {
  return {
    tag: "button",
    type: "danger",
    text: { tag: "plain_text", content: "停止" },
    // 兼容旧 value 回调 + JSON 2.0 behaviors.callback
    value: { action: STOP_ACTION, key, runId },
    behaviors: [
      {
        type: "callback",
        value: { action: STOP_ACTION, key, runId },
      },
    ],
  };
}

/**
 * CardKit schema 2.0 卡片（流式/全量更新共用）。
 * running 必须带停止按钮，避免只有 markdown 无法中止。
 */
export function buildCardKitCardJson(input: {
  status: ReplyCardStatus;
  body?: string;
  key?: string;
  runId?: string;
  note?: string;
  /**
   * 工具执行过程清单（element_id: progress）。
   * - `undefined` = 不插入该元件（progressMode=off，零开销）
   * - `""` = 插入空元件（清单还没内容，但后面要 PUT 上去，元件必须先存在）
   */
  progress?: string;
  /**
   * 折叠面板标题（收起时唯一能看到的一行，通常是「正在执行 bash · npm test」）。
   * 仅在 progressCollapsed 为 true 时生效。
   */
  progressTitle?: string;
  /**
   * 是否把清单收进折叠面板（默认 true）。
   * steps 档清单很长，必须收起；action / timeout 档本来就一行，展开更直接。
   */
  progressCollapsed?: boolean;
  /** 覆盖默认标题；续段用「回复（接上条）」交代上下文 */
  title?: string;
  streaming?: boolean;
  printFrequencyMs?: number;
  printStep?: number;
}) {
  const running = input.status === "running";
  // 暂停等选择时必须保留停止按钮：否则用户只能干等（选择题不自动超时），无法中止这一轮
  const showStop = running || input.status === "paused";
  const body = (input.body || "").trim();
  const note = input.note ? normalizeNote(input.note) : undefined;
  // 清单元件必须排在正文之前：CardKit 只支持按 element_id 更新，元件不存在就 PUT 不上去
  const progressMarkdown = input.progress === undefined
    ? undefined
    : { tag: "markdown", content: input.progress.trim() || " ", element_id: "progress" };
  // 清单默认收进折叠面板：50 行清单直接铺开会把对话淹没。
  // 内层 markdown 仍叫 progress，所以推送内容的 PUT 路径不受影响。
  const progressElement = progressMarkdown === undefined
    ? undefined
    : input.progressCollapsed === false
      ? progressMarkdown
      : {
          tag: "collapsible_panel",
          element_id: "progress_panel",
          // 默认收起；用户自己展开过就保持，不强制改回去
          expanded: false,
          header: {
            title: { tag: "plain_text", content: input.progressTitle || "执行过程" },
            icon_position: "right",
            icon_expanded_angle: -180,
          },
          elements: [progressMarkdown],
        };
  const elements: object[] = [];

  if (running || input.status === "paused") {
    const parts: string[] = [];
    if (note) parts.push(note);
    parts.push(body || (running ? WAITING_TEXT : PAUSED_TEXT));
    if (progressElement) elements.push(progressElement);
    elements.push({
      tag: "markdown",
      content: parts.join("\n\n"),
      element_id: "content",
    });
    if (showStop && input.key) {
      elements.push(buildStopButton(input.key, input.runId));
    }
  } else if (input.status === "done") {
    if (progressElement) elements.push(progressElement);
    elements.push({
      tag: "markdown",
      content: body || " ",
      element_id: "content",
    });
  } else {
    const parts: string[] = [];
    if (note) parts.push(note);
    if (body) parts.push(body);
    if (progressElement) elements.push(progressElement);
    elements.push({
      tag: "markdown",
      content: parts.join("\n\n") || " ",
      element_id: "content",
    });
  }

  const config: Record<string, unknown> = {
    wide_screen_mode: true,
    update_multi: true,
    streaming_mode: Boolean(input.streaming && running),
  };
  if (input.streaming && running) {
    config.streaming_config = {
      print_frequency_ms: { default: input.printFrequencyMs ?? 50 },
      print_step: { default: input.printStep ?? 1 },
    };
  }

  return {
    schema: "2.0",
    config,
    header: {
      template: headerTemplate(input.status),
      title: { tag: "plain_text", content: input.title || titleForStatus(input.status) },
    },
    body: { elements },
  };
}

/**
 * 普通 interactive 消息卡片（非 CardKit 实体）：
 * - running: 标题「回复中」+ 正文 + [停止]
 * - done: 标题「回复」+ 最终正文
 * - stopped/failed: 标题 + 说明
 */
export function buildReplyCard(input: {
  key: string;
  status: ReplyCardStatus;
  note?: string;
  body?: string;
  runId?: string;
  title?: string;
}) {
  const running = input.status === "running";
  const showStop = running || input.status === "paused";
  const body = (input.body || "").trim();
  const note = input.note ? normalizeNote(input.note) : undefined;
  const elements: object[] = [];

  if (running || input.status === "paused") {
    if (note) {
      elements.push({
        tag: "div",
        text: { tag: "lark_md", content: note },
      });
    }
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: body || (running ? WAITING_TEXT : PAUSED_TEXT) },
    });
    // 1.0 interactive 仍可用 action 模块；同时附带 2.0 button 以兼容
    if (showStop) {
      elements.push({
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "停止" },
            type: "danger",
            value: { action: STOP_ACTION, key: input.key, runId: input.runId },
          },
        ],
      });
    }
  } else if (input.status === "done") {
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: body || " " },
    });
  } else {
    if (note) {
      elements.push({
        tag: "div",
        text: { tag: "lark_md", content: note },
      });
    }
    if (body) {
      if (elements.length) elements.push({ tag: "hr" });
      elements.push({
        tag: "div",
        text: { tag: "lark_md", content: body },
      });
    }
    if (!elements.length) {
      elements.push({
        tag: "div",
        text: { tag: "lark_md", content: " " },
      });
    }
  }

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: headerTemplate(input.status),
      title: { tag: "plain_text", content: input.title || titleForStatus(input.status) },
    },
    elements,
  };
}

export function parseStopTaskActionValue(value: unknown): { key: string; runId?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== STOP_ACTION || typeof raw.key !== "string") return undefined;
  return {
    key: raw.key,
    runId: typeof raw.runId === "string" ? raw.runId : undefined,
  };
}

function normalizeNote(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_NOTE_CHARS) return compact;
  return `${compact.slice(0, MAX_NOTE_CHARS - 1)}…`;
}

function titleForStatus(status: ReplyCardStatus) {
  if (status === "done") return "回复";
  if (status === "failed") return "出错了";
  if (status === "stopped") return "已停止";
  if (status === "inactive") return "已结束";
  if (status === "paused") return "等你选择";
  if (status === "answered") return "已选择";
  return "回复中";
}

function headerTemplate(status: ReplyCardStatus) {
  if (status === "done") return "green";
  if (status === "failed") return "red";
  if (status === "stopped") return "grey";
  if (status === "inactive") return "grey";
  if (status === "answered") return "grey";
  if (status === "paused") return "orange";
  return "blue";
}

export function defaultFinalNote(status: ReplyCardFinalStatus): string | undefined {
  if (status === "done") return undefined;
  if (status === "failed") return "处理失败";
  return "已停止";
}
