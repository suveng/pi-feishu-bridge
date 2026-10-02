/**
 * 工具执行过程清单（纯函数 + 无 IO）。
 *
 * 背景：Pi 执行长任务时，飞书「回复中」卡片长时间不动，用户分不清「在干活」还是「卡了」。
 * 这里把 Pi 的 tool_execution_start / tool_execution_end 事件累积成一份可读清单，
 * 由 CardKitStream 推到卡片的独立 markdown 元件（element_id: progress）上，
 * 与正文元件互不抢空间。
 *
 * 四档展示（对应 progressMode 配置）：
 * - off     ：不展示，等价于改造前的行为
 * - steps   ：累积清单，每行一个工具（✅/⏳/❌/⛔ + 工具名 + 命令 + 耗时）
 * - action  ：只显示当前这一个工具那一行
 * - timeout ：平时不显示，单个工具超过阈值才提示「已执行 Ns…」
 */
import { debugLog } from "./debug.ts";

/** 兜底清单卡的清单字节上限，给卡片其余部分留足余量 */
export const OVERSIZE_PROGRESS_BYTES = 8 * 1024;

/** 过程展示档位 */
export type ProgressMode = "off" | "steps" | "action" | "timeout";

/** 单条工具执行记录 */
export type ProgressEntry = {
  toolCallId: string;
  toolName: string;
  /** 单行化后的命令/参数摘要（完整命令，超长才中部省略） */
  detail: string;
  startedAt: number;
  /** 已结束才有值 */
  endedAt?: number;
  /** false = 工具报错（含被中断） */
  ok?: boolean;
  /** 被用户中断（session.abort 后兜底标记） */
  aborted?: boolean;
};

export type ProgressTrackerOptions = {
  mode: ProgressMode;
  /** 清单最多保留多少行，超出折叠（默认 50） */
  maxLines: number;
  /** 超过该秒数才显示耗时（默认 30） */
  timeoutSeconds: number;
  /** 单行命令上限字符数（默认 200） */
  commandChars?: number;
  /**
   * 耗时文本的刷新粒度秒数（默认 5）。
   * 量化到固定粒度，文本才会「五分钟一变」而不是每个 tick 都变，
   * 否则 action / timeout 档会每次 tick 就 PUT 一次卡片。
   */
  refreshSeconds?: number;
};

const DEFAULT_COMMAND_CHARS = 200;
const DEFAULT_REFRESH_SECONDS = 5;
/** 折叠面板标题里的命令摘要长度（只有一行，不能占满） */
const TITLE_DETAIL_CHARS = 30;

/** args 里优先当作「命令」展示的字段（命中即用，避免打印一大坨 JSON） */
const PREFERRED_ARG_KEYS = [
  "command",
  "path",
  "file_path",
  "pattern",
  "query",
  "url",
  "prompt",
];

/**
 * 把工具参数压成一行可读摘要。
 * 优先取常见字段（command / path / ...），否则退回 JSON；统一压成单行并按上限截断。
 */
export function summarizeToolArgs(
  args: unknown,
  maxChars: number = DEFAULT_COMMAND_CHARS,
): string {
  let text = "";
  if (args == null) return "";
  if (typeof args === "string") {
    text = args;
  } else if (typeof args === "object") {
    const record = args as Record<string, unknown>;
    const hit = PREFERRED_ARG_KEYS.find(
      (key) => typeof record[key] === "string" && (record[key] as string).trim() !== "",
    );
    if (hit) {
      text = String(record[hit]);
    } else {
      try {
        text = JSON.stringify(args);
      } catch {
        text = String(args);
      }
    }
  } else {
    text = String(args);
  }
  return toSingleLine(text, maxChars);
}

/** 压成单行并按上限截断（中部省略，保住命令开头与结尾） */
function toSingleLine(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  const head = Math.ceil((maxChars - 1) / 2);
  const tail = Math.floor((maxChars - 1) / 2);
  return `${compact.slice(0, head)}…${compact.slice(compact.length - tail)}`;
}

/** 耗时格式化：<1s 用 ms，<1min 用一位小数秒，再长用 m+s */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 1000) return `${Math.round(safe)}ms`;
  if (safe < 60_000) return `${(safe / 1000).toFixed(1)}s`;
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.round((safe % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

/**
 * 用行内代码包裹一段文本。
 *
 * 不只是好看：命令里的 `*` `_` `[` 等 markdown 特殊字符会直接破坏渲染
 * （`rg -n "*foo*"` 会被吃成斜体），包进代码段才是安全的。
 */
export function inlineCode(text: string): string {
  if (!text) return "";
  if (!text.includes("`")) return `\`${text}\``;
  // 内容自带反引号时改用更长界定符 + 两侧空格（CommonMark 规则），否则代码段会被提前闭合
  return `\`\` ${text} \`\``;
}

/**
 * 行程清单的一行（markdown）。
 * 状态判定优先级：已中断 > 进行中 > 失败 > 成功。
 *
 * 不再用 padEnd 对齐工具名：加粗后渲染宽度不等，补空格反而参差。
 */
export function formatProgressLine(entry: ProgressEntry): string {
  const icon = entry.aborted
    ? "⛔"
    : entry.endedAt == null
      ? "⏳"
      : entry.ok === false
        ? "❌"
        : "✅";
  const name = `**${entry.toolName}**`;
  const detail = entry.detail ? `  ${inlineCode(entry.detail)}` : "";
  const cost = entry.aborted
    ? "  · 已中断"
    : entry.endedAt != null
      ? `  · ${formatDuration(entry.endedAt - entry.startedAt)}`
      : "";
  return `${icon} ${name}${detail}${cost}`;
}

/**
 * 把整块清单转成引用块。
 *
 * 目的：**展开面板后能和正文一眼分开**。引用块在飞书里带左侧竖线与缩进，
 * 而清单与正文是两个独立元件、中间没有任何分隔，不缩进就会连成一片。
 */
function quoteLines(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : line))
    .join("\n");
}

/**
 * 一次执行过程的清单状态机。
 *
 * 只做「记事件 + 渲染文本」，不碰网络也不碰卡片，便于单测。
 * 调用方（ReplyCard）拿到 render() 结果后交给 CardKitStream.setProgress()。
 */
export class ProgressTracker {
  private readonly opts: Required<ProgressTrackerOptions>;
  private readonly entries: ProgressEntry[] = [];
  private readonly byId = new Map<string, ProgressEntry>();

  constructor(options: ProgressTrackerOptions) {
    this.opts = {
      commandChars: DEFAULT_COMMAND_CHARS,
      refreshSeconds: DEFAULT_REFRESH_SECONDS,
      ...options,
    };
  }

  get mode(): ProgressMode {
    return this.opts.mode;
  }

  get size(): number {
    return this.entries.length;
  }

  /** 工具开始。同一 toolCallId 重复上报时原地更新，不新增行 */
  start(toolCallId: string, toolName: string, args: unknown, now: number = Date.now()): void {
    if (!toolCallId) return;
    const existing = this.byId.get(toolCallId);
    if (existing) {
      existing.detail = summarizeToolArgs(args, this.opts.commandChars);
      return;
    }
    const entry: ProgressEntry = {
      toolCallId,
      toolName: toolName || "tool",
      detail: summarizeToolArgs(args, this.opts.commandChars),
      startedAt: now,
    };
    this.byId.set(toolCallId, entry);
    this.entries.push(entry);
  }

  /**
   * 工具结束。未知 id 直接忽略：没有 start 就没有可更新的行，
   * 凭空补一行反而会让清单与实际执行对不上。
   */
  end(toolCallId: string, ok: boolean, now: number = Date.now()): void {
    const entry = this.byId.get(toolCallId);
    if (!entry || entry.endedAt != null) return;
    entry.endedAt = now;
    entry.ok = ok;
  }

  /**
   * 把仍在执行的行全部标记为「已中断」。
   *
   * 必需：session.abort() 不保证发出 tool_execution_end，
   * 不做这步收尾，用户按了停止后清单会一直显示 ⏳，看起来还在跑。
   */
  abortAll(now: number = Date.now()): number {
    let count = 0;
    for (const entry of this.entries) {
      if (entry.endedAt != null) continue;
      entry.endedAt = now;
      entry.aborted = true;
      count += 1;
    }
    if (count > 0) {
      debugLog("feishu.progress.abort_all", { count, total: this.entries.length });
    }
    return count;
  }

  /**
   * 渲染成卡片上要展示的文本。
   * 无内容 / off 档返回 undefined，调用方据此跳过元件写入。
   */
  render(now: number = Date.now()): string | undefined {
    if (this.opts.mode === "off" || this.entries.length === 0) return undefined;
    // 统一加引用前缀：三个档位的输出都要与正文区分开
    if (this.opts.mode === "steps") return quoteLines(this.renderSteps());
    if (this.opts.mode === "action") return quoteLines(this.renderAction(now) ?? "") || undefined;
    return quoteLines(this.renderTimeout(now) ?? "") || undefined;
  }

  /** steps：完整累积清单，超出上限时首行 + 折叠计数 + 末尾若干行 */
  private renderSteps(): string {
    const lines = this.entries.map(formatProgressLine);
    const max = Math.max(3, this.opts.maxLines);
    if (lines.length <= max) return lines.join("\n");
    const tailCount = max - 2;
    const hidden = lines.length - 1 - tailCount;
    return [
      lines[0],
      `… 中间 ${hidden} 步已折叠 …`,
      ...lines.slice(-tailCount),
    ].join("\n");
  }

  /** action：只留当前这一个工具（没有进行中的就留最后一个） */
  private renderAction(now: number): string | undefined {
    const running = this.findRunning();
    const entry = running ?? this.entries[this.entries.length - 1];
    if (!entry) return undefined;
    const line = formatProgressLine(entry);
    if (entry.endedAt != null) return line;
    const elapsed = this.quantizeElapsed(now - entry.startedAt);
    if (elapsed < this.opts.timeoutSeconds * 1000) return line;
    // 附注行也走统一引用前缀，不在这里手写 `>`
    return `${line}\n⏱ 耗时 ${formatDuration(elapsed)}`;
  }

  /** timeout：平时不显示，单个工具跑过阈值才出现 */
  private renderTimeout(now: number): string | undefined {
    const running = this.findRunning();
    if (!running) return undefined;
    const elapsed = this.quantizeElapsed(now - running.startedAt);
    if (elapsed < this.opts.timeoutSeconds * 1000) return undefined;
    return `⚠️ **${running.toolName}** 已执行 ${formatDuration(elapsed)}…`;
  }

  /** 把耗时量化到 refreshSeconds 粒度，避免文本每 tick 都变 */
  private quantizeElapsed(ms: number): number {
    const step = Math.max(1, this.opts.refreshSeconds) * 1000;
    return Math.floor(Math.max(0, ms) / step) * step;
  }

  private findRunning(): ProgressEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      if (this.entries[i].endedAt == null) return this.entries[i];
    }
    return undefined;
  }

  /**
   * 折叠面板的标题摘要（单行）。
   *
   * 这是**面板收起后唯一能看出「还在干活」的东西**：清单一収，用户就又回到
   * 「不知道卡没卡」的状态，而工具执行期间 Pi 不会输出任何正文，面板外的卡片
   * 完全静止 —— 所以标题必须带上当前动作与耗时。
   */
  renderTitle(now: number = Date.now()): string {
    if (this.opts.mode === "off" || this.entries.length === 0) return "执行过程";
    const running = this.findRunning();
    if (!running) return `执行过程（已完成 ${this.entries.length} 步）`;
    const elapsed = this.quantizeElapsed(now - running.startedAt);
    // 单个工具跑很久时，标题上的耗时是「还活着」最直接的证据
    const cost = elapsed >= this.opts.timeoutSeconds * 1000
      ? ` · 已 ${formatDuration(elapsed)}`
      : "";
    const detail = running.detail ? ` · ${toSingleLine(running.detail, TITLE_DETAIL_CHARS)}` : "";
    return `执行过程（正在执行 ${running.toolName}${detail}${cost}）`;
  }
}

/** 该档位是否需要卡片上预留 progress 元件（off 档不预留，零开销） */
export function progressNeedsElement(mode: ProgressMode): boolean {
  return mode !== "off";
}

/** UTF-8 字节数（飞书的卡片体积上限是按字节算的） */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * 按 UTF-8 字节上限裁剪清单，**从末尾保留**（最近执行的步骤优先）。
 *
 * 用在整卡体积超限后的兜底新卡上：那张卡的体积完全由清单决定，
 * 不裁就可能又撞一次上限。
 */
export function trimProgressToBytes(text: string, maxBytes: number): string {
  if (!text || maxBytes <= 0) return "";
  if (byteLength(text) <= maxBytes) return text;

  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const cost = byteLength(lines[i]) + 1; // +1 是换行符
    if (used + cost > maxBytes) break;
    kept.unshift(lines[i]);
    used += cost;
  }
  if (kept.length === 0) return cutToBytes(lines[lines.length - 1], maxBytes);

  // 折叠提示行自己也占字节，必须先算进预算里，否则裁完反而超了
  const build = (keptLines: string[]) =>
    `… 前 ${lines.length - keptLines.length} 行因卡片体积超限未展示\n${keptLines.join("\n")}`;
  // 提示行装不下就从头部继续丢；丢到一行不剩就退回硬切（保最后一行，最新的步骤）
  while (kept.length > 0 && byteLength(build(kept)) > maxBytes) kept.shift();
  return kept.length > 0 ? build(kept) : cutToBytes(lines[lines.length - 1], maxBytes);
}

/** 连一行都放不下时的最后手段：按字节硬切（toString 会丢掉不完整的多字节尾部） */
function cutToBytes(text: string, maxBytes: number): string {
  return `${Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes - 3)).toString("utf8")}…`;
}
