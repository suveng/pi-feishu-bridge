/**
 * 进度通道：把卡片上的「过程清单」推上去的唯一出口。
 *
 * 两个目标元件：
 * - `progress`（markdown）：清单正文，走 `PUT /elements/progress/content`
 * - `progress_panel`（collapsible_panel）：只在收起模式下存在，走 `PATCH /elements/progress_panel`
 *   改标题 —— 面板一收，标题就是用户唯一能看出「还在干活」的地方
 *
 * 从 CardKitStream 抽出来的一层：那边只保留「正文怎么发」，
 * 「进度怎么发」的元件定位、去重、节流都在这里。
 */
import { debugLog } from "./debug.ts";

export type ProgressSnapshot = { title: string; body: string };

export type ProgressChannelDeps = {
  /** progressMode=off 时为 false：所有推送直接跳过，零开销 */
  enabled: boolean;
  /** 是否用了折叠面板（没折叠就没有标题可改） */
  collapsed: boolean;
  baseUrl: () => string;
  /** 卡片还没建好时返回 undefined，此时此刻所有推送都要跳过 */
  cardId: () => string | undefined;
  getToken: () => Promise<string>;
  /** 取下一个严格递增的 sequence —— 全卡共享，两个元件与正文都从它取号 */
  nextSequence: () => number;
};

export class ProgressChannel {
  private readonly deps: ProgressChannelDeps;
  private source: (() => ProgressSnapshot) | undefined;
  /** 去重键用「实际发出去的 content」：原文可能带空白，用原文比较会重复发送 */
  private lastBody: string | null = null;
  private lastTitle: string | null = null;

  constructor(deps: ProgressChannelDeps) {
    this.deps = deps;
  }

  /**
   * 设置取数回调。用回调而不是一次性字符串：`timeout` / `action` 档的
   * 「已执行 Ns」必须随时间长，而 Pi 在单个工具运行期间**不发任何事件**，
   * 只有 tick 能驱动刷新。
   */
  setSource(source: (() => ProgressSnapshot) | undefined): void {
    if (!this.deps.enabled) return;
    this.source = source;
  }

  /** 当前快照（收尾时要拿它定格到终态卡上） */
  snapshot(): ProgressSnapshot {
    if (!this.source) return { title: "", body: "" };
    try {
      const snap = this.source();
      return { title: snap?.title ?? "", body: snap?.body ?? "" };
    } catch (e) {
      debugLog("feishu.progress.source_error", {
        error: e instanceof Error ? e.message : String(e),
      });
      return { title: "", body: "" };
    }
  }

  /** 推送最新快照；内容与标题各走一条接口，各自去重 */
  async tick(): Promise<void> {
    if (!this.deps.enabled || !this.deps.cardId()) return;
    const snap = this.snapshot();
    await this.putBody(snap.body);
    await this.patchTitle(snap.title);
  }

  /**
   * 关流式前强制推一次。
   * 关掉 streaming_mode 后内容接口就不能再用了，此刻不推就永远推不上去。
   */
  async flush(): Promise<void> {
    await this.tick();
  }

  private async putBody(text: string) {
    const content = text.trim() || " "; // 飞书不接受空内容，空清单用一个空格占位
    if (content === this.lastBody) return;
    const cardId = this.deps.cardId();
    if (!cardId) return;
    try {
      const token = await this.deps.getToken();
      const seq = this.deps.nextSequence();
      const res = await fetch(
        `${this.deps.baseUrl()}/open-apis/cardkit/v1/cards/${cardId}/elements/progress/content`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ content, sequence: seq, uuid: `${cardId}_progress_${seq}` }),
        },
      );
      if (!res.ok) {
        debugLog("feishu.cardkit.progress_error", {
          seq,
          status: res.status,
          body: (await res.text()).slice(0, 200),
        });
        return;
      }
      this.lastBody = content;
    } catch (e) {
      debugLog("feishu.cardkit.progress_throw", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * 改折叠面板标题。
   * 注意 `partial_element` 是 **JSON 字符串**（官方文档示例未转义，直接传对象会报错）。
   */
  private async patchTitle(title: string) {
    if (!this.deps.collapsed) return; // 没折叠面板就没标题可改
    const content = title.trim();
    if (!content || content === this.lastTitle) return;
    const cardId = this.deps.cardId();
    if (!cardId) return;
    try {
      const token = await this.deps.getToken();
      const seq = this.deps.nextSequence();
      const res = await fetch(
        `${this.deps.baseUrl()}/open-apis/cardkit/v1/cards/${cardId}/elements/progress_panel`,
        {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            partial_element: JSON.stringify({
              header: { title: { tag: "plain_text", content } },
            }),
            sequence: seq,
            uuid: `${cardId}_panel_${seq}`,
          }),
        },
      );
      if (!res.ok) {
        debugLog("feishu.cardkit.progress_title_error", {
          seq,
          status: res.status,
          body: (await res.text()).slice(0, 200),
        });
        return;
      }
      this.lastTitle = content;
    } catch (e) {
      debugLog("feishu.cardkit.progress_title_throw", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
