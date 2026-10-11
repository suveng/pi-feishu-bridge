/**
 * 进化审批（飞书「审批」应用 v4）——「/learn 应用」落地前的授权通道。
 *
 * 背景：进化（改 `.pi/` 下的规范与代码）不再靠「只能在某个平台做」来限制，
 * 而是靠**飞书审批**：任何人都可以发起进化，但改动必须等审批通过后才落地。
 * 审批是飞书审批应用里的真实审批单，审批人在飞书里点「通过 / 驳回」。
 *
 * 分工：
 * - 本模块只管「审批单」这一件事：查定义拿表单控件 → 创建实例 → 查询状态 → 返回终态。
 * - 「谁在哪个会话发起」由适配器层（PiConversationRuntime）负责，本模块不碰会话。
 *
 * 调用形态（重要）：
 * - `create()` 只建单、**立即返回实例号**，不轮询；`query()` 只查一次状态。
 *   工具侧对应两个工具（submit / status），避免把「等审批人点」挂在一次工具调用上。
 * - `request()` 是**旧调用形态**（建单 + 轮询到终态），仅为兼容保留；新代码不要再走它——
 *   审批人要多久才点没有上限，一个 execute 里 await 到超时会把整轮对话卡死。
 *
 * 关键设计：审批人与表单结构都在**审批定义**里，不在代码里。
 * 所以必须先 GET 定义拿到表单控件 id，再按它构造 form，才能适配任意自建审批。
 */
import { randomUUID } from "node:crypto";
import type { LearnApprovalConfig } from "./types.ts";

/** 审批状态（对外统一口径；未知值一律按在途处理，避免误判成「已通过」） */
export type LearnApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELED" | "TIMEOUT";

/** 等审批的默认超时：10 分钟（查询式询问，一个实例超时不影响 feishu_ask 的等待） */
export const LEARN_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/** 轮询间隔默认 5 秒（审批查询接口限频 100 次/分钟，够用） */
export const LEARN_APPROVAL_POLL_MS = 5 * 1000;

/** 可承载候选点正文的控件类型，按优先级排列：多行文本最适合放清单，其次单行输入 */
const TEXT_WIDGET_TYPES = ["textarea", "input"];

export type LearnApprovalResult = {
  status: LearnApprovalStatus;
  /** 审批实例 code，用于人工排查 */
  instanceCode?: string;
  /** 补充说明（超时/失败原因） */
  detail?: string;
};

/** 「只提交」的结果：要么拿到实例号，要么给出为什么没建出来的原因 */
export type LearnApprovalSubmitResult = {
  ok: boolean;
  /** 已受理时的审批实例 code；后续 query() 用同一个号续查 */
  instanceCode?: string;
  /** ok=false 时的原因（拿不到发起人 / 定义缺控件 / 接口失败） */
  detail?: string;
};

/** 只用到 request 方法，便于单测注入 fake */
export interface LearnApprovalApi {
  request(args: { url: string; method: string; params?: unknown; data?: unknown }): Promise<any>;
}

/**
 * 飞书实例 status → 本模块状态。
 * 飞书取值：PENDING / APPROVED / REJECTED / CANCELED / DELETED。
 * 认不出的值按 PENDING 处理：宁可继续等，也不能把「不知道」当成「已批准」。
 */
export function mapInstanceStatus(raw: unknown): LearnApprovalStatus {
  const value = String(raw ?? "").trim().toUpperCase();
  if (value === "APPROVED") return "APPROVED";
  if (value === "REJECTED") return "REJECTED";
  if (value === "CANCELED" || value === "CANCELLED" || value === "DELETED") return "CANCELED";
  return "PENDING";
}

/**
 * 从审批定义里挑一个能填正文的文本控件。
 *
 * 飞书返回的定义里 `form` 是一段 JSON 字符串，形如
 * `{"widgets":[{"id":"widget1","type":"textarea",...}]}`；
 * 但不同版本/不同建法可能直接给数组，这里两种都认。
 */
export function pickFormWidget(definition: any): { id: string; type: string } | undefined {
  const widgets = parseWidgets(definition);
  if (!widgets.length) return undefined;
  // 按 TEXT_WIDGET_TYPES 的优先级挑：textarea 优先于 input，都不匹配才退第一个控件
  let chosen: any;
  for (const type of TEXT_WIDGET_TYPES) {
    chosen = widgets.find((w) => String(w?.type ?? "").toLowerCase() === type);
    if (chosen) break;
  }
  chosen = chosen ?? widgets[0];
  const id = String(chosen?.id ?? "").trim();
  if (!id) return undefined;
  return { id, type: String(chosen?.type ?? "textarea") };
}

/** 把定义里的 form 字段解析成控件数组（容错：JSON 字符串 / 数组 / {widgets:[]} 都认） */
function parseWidgets(definition: any): any[] {
  const raw = definition?.form ?? definition?.data?.form;
  let parsed: any = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.widgets)) return parsed.widgets;
  return [];
}

/**
 * 构造创建审批实例所需的 form 字段。
 *
 * 飞书要求 form 是**压缩后的 JSON 字符串**，不是对象。
 * 控件类型沿用定义里的原类型，避免类型不匹配被拒。
 */
export function buildInstanceForm(widget: { id: string; type: string }, body: string): string {
  return JSON.stringify([{ id: widget.id, type: widget.type, value: body }]);
}

/** 把审批结果转成给模型看的文本（模型据此决定是否动手） */
export function formatApprovalOutcome(result: LearnApprovalResult): string {
  const code = result.instanceCode ? `（审批实例 ${result.instanceCode}）` : "";
  switch (result.status) {
    case "APPROVED":
      return `审批已通过${code}：可以按被授权的候选点落地。落地完成后必须物理删除对应反馈文件。`;
    case "REJECTED":
      return `审批被驳回${code}：一个字都不要改。等审批人说明原因。`;
    case "CANCELED":
      return `审批已被撤回/删除${code}：一个字都不要改。`;
    case "TIMEOUT":
      // 超时 ≠ 否决：单子大概率还在飞书里等审批人点。重发会造出第二张单（uuid 幂等键只防网络重试），
      // 所以这里只让模型「拿实例号续查」，绝不放行。
      return `等待审批超时${code}：${result.detail ?? "审批人未在超时前处理"}。`
        + `实例可能仍在审批中，**不要重发**，隔一会儿用 feishu_learn_approval_status 传同一实例号续查；`
        + "拿到 APPROVED 之前一个字都不要改。";
    default:
      return `审批仍在进行中${code}：不要动手，隔一会儿用 feishu_learn_approval_status 传同一实例号续查；`
        + `PENDING 不等于通过，一个字都不要改。${result.detail ? `（${result.detail}）` : ""}`;
  }
}

/** 把「只提交」的结果转成给模型看的文本（模型据此知道去续查，而不是等着或动手） */
export function formatSubmitOutcome(result: LearnApprovalSubmitResult): string {
  if (!result.ok || !result.instanceCode) {
    return `提交进化审批失败：${result.detail ?? "未知原因"}。一个字都不要改，把原因告诉用户。`;
  }
  return `审批已提交（审批实例 ${result.instanceCode}）：请在飞书里点「通过」。`
    + "拿到 APPROVED 之前一个字都不要改；"
    + "结果用 feishu_learn_approval_status 传这个实例号续查，不要重复提交（重复提交会造出第二张单）。";
}

export interface LearnApprovalClientDeps {
  api: LearnApprovalApi;
  config: LearnApprovalConfig;
  /** 注入 sleep，单测时可把轮询加速 */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (event: string, data?: unknown) => void;
}

export class LearnApprovalClient {
  private readonly api: LearnApprovalApi;
  private readonly config: LearnApprovalConfig;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: (event: string, data?: unknown) => void;
  private widget: { id: string; type: string } | undefined;

  constructor(deps: LearnApprovalClientDeps) {
    this.api = deps.api;
    this.config = deps.config;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? (() => {});
  }

  private get timeoutMs() {
    return (this.config.timeoutSec ?? LEARN_APPROVAL_TIMEOUT_MS / 1000) * 1000;
  }

  private get pollMs() {
    return (this.config.pollIntervalSec ?? LEARN_APPROVAL_POLL_MS / 1000) * 1000;
  }

  /** 查审批定义拿表单控件（缓存：审批定义很少变，每次都查会白吃限频） */
  private async resolveWidget(): Promise<{ id: string; type: string }> {
    if (this.widget) return this.widget;
    const res = await this.api.request({
      url: `/open-apis/approval/v4/approvals/${encodeURIComponent(this.config.approvalCode)}`,
      method: "GET",
    });
    const widget = pickFormWidget(res?.data ?? res);
    if (!widget) {
      throw new Error(
        "审批定义里找不到可填写的文本控件：请在飞书审批后台给该审批加一个「多行文本」控件后重试。",
      );
    }
    this.widget = widget;
    return widget;
  }

  /**
   * 只提交：查定义 → 建实例 → **立即返回实例号，不轮询、不等待**。
   * 失败一律以 ok=false + detail 返回（不抛错），让上层把原因原样讲给用户。
   */
  async create(input: { body: string; applicantOpenId: string }): Promise<LearnApprovalSubmitResult> {
    const applicant = String(input.applicantOpenId ?? "").trim();
    if (!applicant) {
      return { ok: false, detail: "拿不到发起人的 open_id，无法发起审批。" };
    }
    let widget: { id: string; type: string };
    try {
      widget = await this.resolveWidget();
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
    let created: any;
    try {
      created = await this.api.request({
        url: "/open-apis/approval/v4/instances",
        method: "POST",
        data: {
          approval_code: this.config.approvalCode,
          open_id: applicant,
          form: buildInstanceForm(widget, input.body),
          // 幂等键：同一 uuid 只会生成一个实例（重复提交返回 60012），避免网络重试造出两张单
          uuid: randomUUID(),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log("feishu.learn_approval.create_failed", { applicant, error: message });
      return { ok: false, detail: `创建审批实例失败：${message}` };
    }
    const instanceCode = String(created?.data?.instance_code ?? created?.instance_code ?? "").trim();
    if (!instanceCode) {
      return { ok: false, detail: `创建审批实例失败：${summarize(created)}` };
    }
    this.log("feishu.learn_approval.created", { instanceCode, applicant });
    return { ok: true, instanceCode };
  }

  /**
   * 只查一次状态：给「提交后用实例号续查」用，**不轮询、不阻塞**。
   * 查询失败按在途（PENDING）返回——「查不到」绝不等于「已通过」。
   */
  async query(instanceCode: string): Promise<LearnApprovalResult> {
    const code = String(instanceCode ?? "").trim();
    if (!code) {
      return { status: "PENDING", detail: "缺少审批实例号，无法查询。" };
    }
    try {
      const res = await this.api.request({
        url: `/open-apis/approval/v4/instances/${encodeURIComponent(code)}`,
        method: "GET",
      });
      const status = mapInstanceStatus(res?.data?.status ?? res?.status);
      this.log("feishu.learn_approval.queried", { instanceCode: code, status });
      return { status, instanceCode: code };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log("feishu.learn_approval.query_failed", { instanceCode: code, error: message });
      return { status: "PENDING", instanceCode: code, detail: `查询审批状态失败：${message}` };
    }
  }

  /**
   * 【旧形态，保留兼容】发起一次进化审批并轮询到终态。
   * 新代码请用 create() + query()：本方法会把调用方卡在等待上（最长 timeoutSec 秒）。
   * 返回 APPROVED 才允许落地；其余一律不许动文件。
   */
  async request(input: { body: string; applicantOpenId: string }): Promise<LearnApprovalResult> {
    const applicant = String(input.applicantOpenId ?? "").trim();
    if (!applicant) {
      return { status: "CANCELED", detail: "拿不到发起人的 open_id，无法发起审批。" };
    }
    const created = await this.create(input);
    if (!created.ok || !created.instanceCode) {
      throw new Error(created.detail ?? "创建审批实例失败");
    }
    return this.poll(created.instanceCode);
  }

  /** 轮询审批状态直到终态或超时 */
  private async poll(instanceCode: string): Promise<LearnApprovalResult> {
    const deadline = this.now() + this.timeoutMs;
    while (this.now() < deadline) {
      await this.sleep(this.pollMs);
      let status: LearnApprovalStatus;
      try {
        const res = await this.api.request({
          url: `/open-apis/approval/v4/instances/${encodeURIComponent(instanceCode)}`,
          method: "GET",
        });
        status = mapInstanceStatus(res?.data?.status ?? res?.status);
      } catch (error) {
        // 单次查询失败不结束等待：审批可能已经通过，下一个周期再拿
        this.log("feishu.learn_approval.poll_failed", {
          instanceCode,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      this.log("feishu.learn_approval.poll", { instanceCode, status });
      if (status !== "PENDING") return { status, instanceCode };
    }
    return {
      status: "TIMEOUT",
      instanceCode,
      detail: `超过 ${Math.round(this.timeoutMs / 1000)} 秒仍未审批`,
    };
  }
}

function summarize(res: any): string {
  try {
    const text = JSON.stringify(res);
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  } catch {
    return String(res);
  }
}
