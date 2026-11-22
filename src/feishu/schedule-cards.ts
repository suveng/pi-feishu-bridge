/**
 * 定时任务的飞书卡片：管理面板 + 新建表单。
 *
 * 卡片里所有按钮的 value.action 都以 `pi_feishu_sched_` 开头，
 * 由 card-actions.ts 统一分派到 FeishuScheduleService。
 */
import { sharedCardConfig } from "./cards.ts";
import { describeCron, describeInterval, formatLocal, parseCron, computeNextRunAt } from "./schedule-time.ts";
import type { ScheduleJob } from "./schedule-store.ts";

/** 管理卡最多列出的任务数：再多卡片会超长，剩下的用 /sched list 看 */
export const MAX_LISTED_JOBS = 10;

export type ScheduleActionValue =
  | { action: "pi_feishu_sched_toggle"; id: string }
  | { action: "pi_feishu_sched_run"; id: string }
  | { action: "pi_feishu_sched_notify"; id: string }
  | { action: "pi_feishu_sched_delete"; id: string; confirm?: boolean }
  | { action: "pi_feishu_sched_add" }
  | { action: "pi_feishu_sched_refresh" }
  | { action: "pi_feishu_sched_create" };

const ACTION_PREFIX = "pi_feishu_sched_";

export function isScheduleActionValue(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && typeof (value as { action?: unknown }).action === "string"
    && ((value as { action: string }).action).startsWith(ACTION_PREFIX));
}

export function parseScheduleActionValue(value: unknown): ScheduleActionValue | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const action = typeof v.action === "string" ? v.action : "";
  if (!action.startsWith(ACTION_PREFIX)) return undefined;
  const id = typeof v.id === "string" ? v.id : "";
  switch (action) {
    case "pi_feishu_sched_toggle":
    case "pi_feishu_sched_run":
    case "pi_feishu_sched_notify":
      return id ? { action, id } : undefined;
    case "pi_feishu_sched_delete":
      return id ? { action, id, confirm: v.confirm === true } : undefined;
    case "pi_feishu_sched_add":
    case "pi_feishu_sched_refresh":
    case "pi_feishu_sched_create":
      return { action } as ScheduleActionValue;
    default:
      return undefined;
  }
}

/** 表单里三个输入框的 name；回调的 formValue 用它取值，改了要同步 service */
export const SCHEDULE_FORM = {
  formName: "sched_new_form",
  nameField: "sched_name",
  timeField: "sched_time",
  promptField: "sched_prompt",
  submit: "sched_submit",
} as const;

function statusLine(job: ScheduleJob, now: number): string {
  if (!job.enabled) {
    return job.kind === "once" ? "⚪ 已执行（一次性任务）" : "⏸ 已暂停";
  }
  const next = computeNextRunAt(job, now);
  const nextText = next ? `下次 ${formatLocal(next)}` : "下次触发时间算不出来（表达式可能已失效）";
  return `🟢 运行中｜${nextText}`;
}

function lastLine(job: ScheduleJob): string {
  if (!job.lastRunAt) return "上次：还没跑过";
  const at = formatLocal(job.lastRunAt);
  if (job.lastStatus === "failed") {
    const err = (job.lastError || "").replace(/\s+/g, " ").slice(0, 60);
    return `上次：${at} ❌ ${err || "失败"}`;
  }
  return `上次：${at} ✅`;
}

function scheduleLine(job: ScheduleJob): string {
  if (job.kind === "cron" && job.cron) {
    let readable = job.timeLabel;
    try {
      readable = describeCron(parseCron(job.cron));
    } catch {
      // 表达式坏了就退回创建时的描述
    }
    return `时间：${readable}（cron \`${job.cron}\`）`;
  }
  if (job.kind === "every" && job.everyMs) return `时间：${describeInterval(job.everyMs)}`;
  if (job.kind === "once" && job.at) return `时间：${formatLocal(job.at)}（一次性）`;
  return `时间：${job.timeLabel}`;
}

function promptPreview(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

function button(label: string, value: ScheduleActionValue, type: "primary" | "default" | "danger" = "default") {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    value,
  };
}

export type ScheduleCardOptions = {
  /** 当前会话的通知落点说明（让用户确认「在哪创建就通知在哪」） */
  originLabel?: string;
  /** 操作结果提示（已创建 / 已暂停 / 已删除…） */
  note?: string;
  /** 已点过一次删除、等二次确认的任务编号 */
  pendingDeleteId?: string;
  now?: number;
};

export function buildScheduleCard(jobs: ScheduleJob[], options: ScheduleCardOptions = {}) {
  const now = options.now ?? Date.now();
  const elements: any[] = [];

  const origin = options.originLabel ? `本会话通知落点：**${options.originLabel}**` : "通知落在任务创建时的会话。";
  if (options.note) {
    elements.push({ tag: "markdown", content: options.note });
  }
  elements.push({
    tag: "markdown",
    content: [
      `${origin}`,
      `共 **${jobs.length}** 个任务${jobs.length > MAX_LISTED_JOBS ? `（下面只列前 ${MAX_LISTED_JOBS} 个，其余用 \`/sched list\` 查看）` : ""}`,
      "点任务行下方的按钮即可暂停 / 立即执行 / 改通知到这里 / 删除。",
    ].join("\n"),
  });

  if (!jobs.length) {
    elements.push({
      tag: "markdown",
      content: "还没有定时任务。点下面的「新建任务」，或发送 `/sched add` 打开创建表单。",
    });
  }

  jobs.slice(0, MAX_LISTED_JOBS).forEach((job, index) => {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "markdown",
      content: [
        `**${index + 1}. ${job.name}**　\`${job.id}\``,
        statusLine(job, now),
        scheduleLine(job),
        lastLine(job),
        `任务：${promptPreview(job.prompt)}`,
        job.target.label ? `通知到：${job.target.label}` : undefined,
      ].filter(Boolean).join("\n"),
    });
    const confirm = options.pendingDeleteId === job.id;
    elements.push({
      tag: "action",
      actions: confirm
        ? [
            button("⚠️ 确认删除", { action: "pi_feishu_sched_delete", id: job.id, confirm: true }, "danger"),
            button("取消", { action: "pi_feishu_sched_refresh" }),
          ]
        : [
            button(job.enabled ? "暂停" : "恢复", { action: "pi_feishu_sched_toggle", id: job.id }),
            button("立即执行", { action: "pi_feishu_sched_run", id: job.id }),
            button("改通知到这里", { action: "pi_feishu_sched_notify", id: job.id }),
            button("删除", { action: "pi_feishu_sched_delete", id: job.id }, "danger"),
          ],
    });
  });

  elements.push({ tag: "hr" });
  elements.push({
    tag: "markdown",
    content: [
      "**命令**（也可以直接发）：",
      "`/sched add` 新建　`/sched list` 列表",
      "`/sched pause 编号` 暂停　`/sched resume 编号` 恢复",
      "`/sched run 编号` 立刻跑一次　`/sched del 编号` 删除",
      "`/sched notify 编号` 把通知改到当前会话　`/sched info 编号` 看详情",
    ].join("\n"),
  });
  elements.push({
    tag: "action",
    actions: [
      button("➕ 新建任务", { action: "pi_feishu_sched_add" }, "primary"),
      button("刷新", { action: "pi_feishu_sched_refresh" }),
    ],
  });

  return {
    config: sharedCardConfig(),
    header: {
      template: "turquoise",
      title: { tag: "plain_text", content: `⏰ 定时任务（${jobs.length}）` },
    },
    elements,
  };
}

/** 新建任务表单：名称 / 时间 / 任务内容 三段输入 */
export function buildScheduleFormCard(options: { originLabel?: string } = {}) {
  const input = (name: string, placeholder: string, extra: Record<string, unknown> = {}) => ({
    tag: "input",
    name,
    placeholder: { tag: "plain_text", content: placeholder },
    ...extra,
  });

  return {
    config: sharedCardConfig(),
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "新建定时任务" },
    },
    elements: [
      {
        tag: "markdown",
        content: [
          options.originLabel
            ? `通知会发到**本会话**：${options.originLabel}`
            : "通知会发到创建任务的本会话。",
          "建好后可以用 `/sched notify 编号` 改到别的会话。",
        ].join("\n"),
      },
      {
        tag: "form",
        name: SCHEDULE_FORM.formName,
        elements: [
          input(SCHEDULE_FORM.nameField, "任务名称，例如 每日生产巡检", { max_length: 40 }),
          input(SCHEDULE_FORM.timeField, "时间：每天 09:00 / 每 2 小时 / 2026-11-22 09:00 / cron 0 9 * * *", {
            max_length: 80,
          }),
          input(SCHEDULE_FORM.promptField, "要 pi 执行的内容（会开一个全新会话执行）", {
            input_type: "multiline_text",
            rows: 4,
            auto_resize: true,
            // 飞书输入框的 max_length 上限就是 1000，写 2000 整张卡片会被拒：
            // 230099 / 11310 "max_length exceed the default maximum 1000"（HTTP 400，
            // 桥接只显示 axios 的 "Request failed with status code 400"，很难看出原因）。
            max_length: 1000,
          }),
          {
            tag: "button",
            name: SCHEDULE_FORM.submit,
            action_type: "form_submit",
            type: "primary",
            text: { tag: "plain_text", content: "创建任务" },
            value: { action: "pi_feishu_sched_create" },
          },
        ],
      },
      {
        tag: "markdown",
        content:
          "> 时间写法：`每天 09:00`｜`工作日 09:00`｜`每周一 09:00`｜`每小时`｜`每 30 分钟`｜`2026-11-22 09:00`｜`cron 0 9 * * *`",
      },
    ],
  };
}

