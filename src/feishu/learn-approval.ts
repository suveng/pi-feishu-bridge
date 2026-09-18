/**
 * 进化审批（飞书「审批」应用 v4）——「/learn 应用」落地前的授权通道。
 *
 * 背景：进化（改 `.pi/` 下的规范与代码）不再靠「只能在某个平台做」来限制，
 * 而是靠**飞书审批**：任何人都可以发起进化，但改动必须等审批通过后才落地。
 * 审批是飞书审批应用里的真实审批单，审批人在飞书里点「通过 / 驳回」。
 *
 * 分工：
 * - 本模块只管「审批单」这一件事：查定义拿表单控件 → 创建实例 → 轮询状态 → 返回终态。
 * - 「谁在哪个会话发起」由适配器层（PiConversationRuntime）负责，本模块不碰会话。
 *
 * 关键设计：审批人与表单结构都在**审批定义**里，不在代码里。
 * 所以必须先 GET 定义拿到表单控件 id，再按它构造 form，才能适配任意自建审批。
 */
import { randomUUID } from "node:crypto";
import type { LearnApprovalConfig } from "./types.ts";

/** 审批状态（对外统一口径；未知值一律按在途处理，避免误判成「已通过」） */
export type LearnApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELED" | "TIMEOUT";

/** 等审批的默认超时：10 分钟，与 feishu_ask 选择题超时保持一致 */
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
      return `等待审批超时${code}：${result.detail ?? "审批人未在超时前处理"}。一个字都不要改，可让用户重新发起。`;
    default:
      return `审批仍在进行中${code}：不要动手。`;
  }
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
   * 发起一次进化审批并等结果。
   * 返回 APPROVED 才允许落地；其余一律不许动文件。
   */
  async request(input: { body: string; applicantOpenId: string }): Promise<LearnApprovalResult> {
    const applicant = String(input.applicantOpenId ?? "").trim();
    if (!applicant) {
      return { status: "CANCELED", detail: "拿不到发起人的 open_id，无法发起审批。" };
    }
    const widget = await this.resolveWidget();
    const created = await this.api.request({
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
    const instanceCode = String(created?.data?.instance_code ?? created?.instance_code ?? "").trim();
    if (!instanceCode) {
      throw new Error(`创建审批实例失败：${summarize(created)}`);
    }
    this.log("feishu.learn_approval.created", { instanceCode, applicant });
    return this.poll(instanceCode);
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
