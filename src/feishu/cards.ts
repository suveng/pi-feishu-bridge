import { type ThinkingStatus } from "./thinking.ts";
import type { RuntimeModel } from "./runtime.ts";

export function modelLabel(model: RuntimeModel | undefined) {
  if (!model) return "未选择";
  return `${model.provider}/${model.id}`;
}

export type ResumeScope = "current" | "all";

export type ResumeSessionItem = {
  path: string;
  title: string;
  subtitle: string;
  modifiedLabel: string;
  workspaceLabel?: string;
  isCurrent: boolean;
};

export type ResumeSessionPage = {
  key: string;
  /** 当前飞书会话绑定的工作区；无论浏览哪个范围都用于说明筛选上下文。 */
  workspacePath: string;
  scope: ResumeScope;
  page: number;
  total: number;
  totalPages: number;
  items: ResumeSessionItem[];
};

export function buildModelCard(key: string, models: RuntimeModel[], currentModel: RuntimeModel | undefined) {
  const current = modelLabel(currentModel);
  const elements: any[] = [
    {
      tag: "markdown",
      content: `当前模型：**${current}**\n点击下面的按钮即可切换当前飞书会话使用的模型。`,
    },
  ];

  const rows: any[][] = [];
  for (let i = 0; i < models.length; i += 2) {
    rows.push(models.slice(i, i + 2));
  }

  for (const row of rows) {
    elements.push({
      tag: "action",
      actions: row.map((model) => {
        const isCurrent = currentModel?.provider === model.provider && currentModel?.id === model.id;
        return {
          tag: "button",
          text: {
            tag: "plain_text",
            content: `${isCurrent ? "当前 " : ""}${model.provider}/${model.id}`,
          },
          type: isCurrent ? "primary" : "default",
          value: {
            action: "pi_feishu_select_model",
            key,
            provider: model.provider,
            modelId: model.id,
          },
        };
      }),
    });
  }

  return {
    config: sharedCardConfig(),
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "选择 Pi 模型" },
    },
    elements,
  };
}

export function buildThinkingCard(key: string, currentModel: RuntimeModel | undefined, status: ThinkingStatus) {
  const model = modelLabel(currentModel);
  const elements: any[] = [
    {
      tag: "markdown",
      content: !status.available
        ? `当前模型：**${model}**\n无法读取这个模型可用的 thinking levels，因此未显示任何猜测的选项。`
        : status.availableLevels.length === 0
          ? `当前模型：**${model}**\n当前模型未返回可用的 thinking levels。`
          : `当前模型：**${model}**\nCurrent: **${escapeMarkdown(status.currentLevel || "(unknown)")}**\n以下选项由当前会话直接返回。`,
    },
  ];

  if (status.available) {
    for (let i = 0; i < status.availableLevels.length; i += 3) {
      const row = status.availableLevels.slice(i, i + 3);
      elements.push({
        tag: "action",
        actions: row.map((level) => {
          const isCurrent = level === status.currentLevel;
          return {
            tag: "button",
            text: {
              tag: "plain_text",
              content: level,
            },
            type: isCurrent ? "primary" : "default",
            value: {
              action: "pi_feishu_select_thinking",
              key,
              level,
            },
          };
        }),
      });
    }
  }

  return {
    config: sharedCardConfig(),
    header: {
      template: "purple",
      title: { tag: "plain_text", content: "调整思考强度" },
    },
    elements,
  };
}

/**
 * 「消息投递方式」卡片：正在生成回复时又收到新消息，是排队还是立即打断。
 * 这是**全局**运行时配置（runtime-overrides.json），卡片只负责查看与切换。
 */
export function buildDeliveryCard(current: "queue" | "interrupt" | undefined) {
  const mode: "queue" | "interrupt" = current === "interrupt" ? "interrupt" : "queue";
  const elements: any[] = [
    {
      tag: "markdown",
      content: [
        `当前设置：**${mode === "interrupt" ? "立即打断" : "排队"}**`,
        "",
        mode === "interrupt"
          ? "生成中你发新消息 → 立刻掰掉上一轮，用新消息开新一轮（上一轮已生成的内容留在它自己那张卡上）。"
          : "生成中你发新消息 → 排在上一轮后面，等它跑完再处理。（新消息的卡片会先出现但暂时空白）",
        "",
        "> 这是全局设置，对本地所有飞书会话生效；清除用 `/config clear messageDelivery`。",
      ].join("\n"),
    },
    {
      tag: "action",
      actions: [
        buildDeliveryButton("排队", "queue", mode === "queue"),
        buildDeliveryButton("立即打断", "interrupt", mode === "interrupt"),
      ],
    },
  ];

  return {
    config: sharedCardConfig(),
    header: {
      template: "orange",
      title: { tag: "plain_text", content: "消息投递方式" },
    },
    elements,
  };
}

function buildDeliveryButton(label: string, mode: "queue" | "interrupt", active: boolean) {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type: active ? "primary" : "default",
    value: {
      action: "pi_feishu_select_delivery",
      mode,
    },
  };
}

export function parseDeliveryActionValue(value: unknown): { mode: "queue" | "interrupt" } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_select_delivery") return undefined;
  if (raw.mode !== "queue" && raw.mode !== "interrupt") return undefined;
  return { mode: raw.mode };
}

export function buildResumeCard(data: ResumeSessionPage) {
  const elements: any[] = [
    {
      tag: "markdown",
      content: [
        `当前工作区：**${escapeMarkdown(data.workspacePath)}**`,
        data.total
          ? `第 **${data.page + 1} / ${data.totalPages}** 页，共 **${data.total}** 条历史会话。`
          : "还没有可切换的历史会话。",
        "点击某条会话后，当前飞书对话会继续接着这条 Pi 会话往下聊。",
      ].join("\n"),
    },
  ];

  elements.push({
    tag: "action",
    actions: [
      buildResumeScopeButton(data.key, "current", data.scope === "current"),
      buildResumeScopeButton(data.key, "all", data.scope === "all"),
    ],
  });

  for (const item of data.items) {
    const lines = [
      `**${escapeMarkdown(item.title)}**${item.isCurrent ? " `当前使用中`" : ""}`,
      escapeMarkdown(item.subtitle),
      `更新时间：${escapeMarkdown(item.modifiedLabel)}`,
    ];
    if (item.workspaceLabel) lines.push(`工作区：${escapeMarkdown(item.workspaceLabel)}`);
    elements.push({
      tag: "markdown",
      content: lines.join("\n"),
    });
    elements.push({
      tag: "action",
      actions: [{
        tag: "button",
        text: {
          tag: "plain_text",
          content: item.isCurrent ? "当前会话" : "切换到这条会话",
        },
        type: item.isCurrent ? "primary" : "default",
        value: {
          action: "pi_feishu_resume_select",
          key: data.key,
          scope: data.scope,
          page: data.page,
          sessionPath: item.path,
        },
      }],
    });
  }

  elements.push({
    tag: "action",
    actions: [
      {
        tag: "button",
        text: { tag: "plain_text", content: "上一页" },
        type: "default",
        disabled: data.page <= 0,
        value: {
          action: "pi_feishu_resume_page",
          key: data.key,
          scope: data.scope,
          page: Math.max(0, data.page - 1),
        },
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "下一页" },
        type: "default",
        disabled: data.page >= data.totalPages - 1,
        value: {
          action: "pi_feishu_resume_page",
          key: data.key,
          scope: data.scope,
          page: Math.min(Math.max(0, data.totalPages - 1), data.page + 1),
        },
      },
    ],
  });

  return {
    config: sharedCardConfig(),
    header: {
      template: "turquoise",
      title: { tag: "plain_text", content: "切换 Pi 历史会话" },
    },
    elements,
  };
}

export function parseModelActionValue(value: unknown): { key: string; provider: string; modelId: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_select_model") return undefined;
  if (typeof raw.key !== "string" || typeof raw.provider !== "string" || typeof raw.modelId !== "string") return undefined;
  return { key: raw.key, provider: raw.provider, modelId: raw.modelId };
}

export function parseThinkingActionValue(value: unknown): { key: string; level: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_select_thinking") return undefined;
  if (typeof raw.key !== "string" || typeof raw.level !== "string" || !raw.level.trim()) return undefined;
  return { key: raw.key, level: raw.level };
}

export function parseResumePageActionValue(value: unknown): { key: string; scope: ResumeScope; page: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_resume_page") return undefined;
  if (typeof raw.key !== "string") return undefined;
  if (raw.scope !== "current" && raw.scope !== "all") return undefined;
  if (typeof raw.page !== "number" || !Number.isFinite(raw.page)) return undefined;
  return { key: raw.key, scope: raw.scope, page: Math.max(0, Math.floor(raw.page)) };
}

export function parseResumeSelectActionValue(value: unknown): { key: string; scope: ResumeScope; page: number; sessionPath: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_resume_select") return undefined;
  if (typeof raw.key !== "string" || typeof raw.sessionPath !== "string") return undefined;
  if (raw.scope !== "current" && raw.scope !== "all") return undefined;
  if (typeof raw.page !== "number" || !Number.isFinite(raw.page)) return undefined;
  return {
    key: raw.key,
    scope: raw.scope,
    page: Math.max(0, Math.floor(raw.page)),
    sessionPath: raw.sessionPath,
  };
}

function buildResumeScopeButton(key: string, scope: ResumeScope, active: boolean) {
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content: scope === "current" ? "当前工作区" : "全部会话",
    },
    type: active ? "primary" : "default",
    value: {
      action: "pi_feishu_resume_page",
      key,
      scope,
      page: 0,
    },
  };
}

function escapeMarkdown(text: string) {
  return text.replace(/[`*_~]/g, "\\$&");
}

function sharedCardConfig() {
  return {
    wide_screen_mode: true,
    update_multi: true,
  };
}

/**
 * 重启回执卡。三态共用同一张卡（`transport.updateCard` 原地改写），
 * 所以用户看到的是「重启中 → 已重启」，而不是两条互不相干的消息。
 */
export type RestartCardState =
  | { stage: "restarting"; commit?: string; at: number }
  | { stage: "done"; commit?: string; elapsedMs?: number; newPid?: number; at: number }
  | { stage: "failed"; error: string; at: number }
  | { stage: "unknown"; at: number };

export function buildRestartCard(state: RestartCardState) {
  const time = new Date(state.at).toLocaleTimeString("zh-CN", { hour12: false });
  const commitOf = (value?: string) => (value ? `\n代码版本：\`${escapeMarkdown(value)}\`` : "");
  if (state.stage === "restarting") {
    return {
      config: sharedCardConfig(),
      header: { template: "blue", title: { tag: "plain_text", content: "🔄 正在重启桥接" } },
      elements: [
        {
          tag: "markdown",
          content: [
            `开始时间：${time}`,
            "正在重载最新代码。会话上下文会保留，重启后可以直接接着聊。",
            "预计 2–4 秒；这段时间内发出的消息可能收不到，请等这张卡变成「已重启」再发。",
          ].join("\n") + commitOf(state.commit),
        },
      ],
    };
  }
  if (state.stage === "done") {
    const seconds = typeof state.elapsedMs === "number" ? `${(state.elapsedMs / 1000).toFixed(1)}s` : "未知";
    return {
      config: sharedCardConfig(),
      header: { template: "green", title: { tag: "plain_text", content: "✅ 桥接已重启" } },
      elements: [
        {
          tag: "markdown",
          content: [
            `耗时：${seconds}${typeof state.newPid === "number" ? ` · pid ${state.newPid}` : ""}`,
            "会话上下文已保留，继续发消息即可。",
          ].join("\n") + commitOf(state.commit),
        },
      ],
    };
  }
  if (state.stage === "failed") {
    return {
      config: sharedCardConfig(),
      header: { template: "red", title: { tag: "plain_text", content: "❌ 桥接重启失败" } },
      elements: [
        {
          tag: "markdown",
          content: `${escapeMarkdown(state.error)}\n\n桥接当前可能已停止。请在 Pi 终端执行 \`/feishu start\` 重新拉起。`,
        },
      ],
    };
  }
  return {
    config: sharedCardConfig(),
    header: { template: "orange", title: { tag: "plain_text", content: "✅ 桥接已重启（回执缺失）" } },
    elements: [
      {
        tag: "markdown",
        content: "重启 worker 未留下结果文件（可能中途被杀），但新进程已接管网关锁，可以正常发消息。",
      },
    ],
  };
}
