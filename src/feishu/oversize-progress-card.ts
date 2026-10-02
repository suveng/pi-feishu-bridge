/**
 * 卡片体积超限时的兜底：新发一条「只带执行清单」的消息卡片。
 *
 * 背景：飞书卡片 JSON 有个约 30KB 的硬上限（错误码 200860）。收尾时要把整张卡
 * 重发一遍（为了把标题从「回复中」改成「回复」），一旦正文把整卡撑爆，这次
 * 更新就失败，卡片会**永远停在「回复中」**——正是本改造要消灭的症状。
 *
 * 为什么不原地重试：正文本身就是撑爆整卡的主因，去掉清单也未必救得回来；
 * 而正文用户已经从流式输出里看完了，真正丢的是「这轮结束了」+ 执行清单。
 * 新开一条消息，体积只由清单决定，先裁到 8KB 再发，就不会再撞。
 *
 * 本模块不碰 CardKitStream 的内部状态，只收参数、发消息，便于单测。
 */
import { buildReplyCard, type ReplyCardStatus } from "./card-builder.ts";
import { OVERSIZE_PROGRESS_BYTES, byteLength, trimProgressToBytes } from "./progress-note.ts";
import { debugLog } from "./debug.ts";
import { withRetry } from "./retry.ts";

type SendTarget = { chatId: string } | { replyToMessageId: string };

type ApiResponse = { code?: number; msg?: string; data?: { message_id?: string } };

export type OversizeProgressCardInput = {
  baseUrl: string;
  /** 取 tenant_access_token（带缓存由调用方负责） */
  getToken: () => Promise<string>;
  target: SendTarget;
  conversationKey?: string;
  runId?: string;
  /** 原卡标题，兜底卡会加「· 执行过程」后缀 */
  title?: string;
  finalStatus: ReplyCardStatus;
  /** 已渲染好的清单全文（会按字节裁剪） */
  progress: string;
  onOutboundMessageId?: (messageId: string) => void;
};

/**
 * 发送兜底清单卡。**失败不抛**：这是补救流程，它自己挂了不能反过来搞砸主流程。
 */
export async function sendOversizeProgressCard(input: OversizeProgressCardInput): Promise<boolean> {
  const progress = input.progress.trim();
  if (!progress) return false; // 没有清单就没什么可补的，别多刷一条消息

  try {
    const token = await withRetry(input.getToken, {
      maxRetries: 3,
      label: "feishu.cardkit.oversize_token",
    });
    const trimmed = trimProgressToBytes(progress, OVERSIZE_PROGRESS_BYTES);
    const card = buildReplyCard({
      key: input.conversationKey ?? "",
      runId: input.runId,
      status: input.finalStatus,
      title: `${input.title ?? "回复"} · 执行过程`,
      body: `${trimmed}\n\n> 正文见上一条（卡片体积超限，未随本条重复发送）`,
    });

    const isCreate = "chatId" in input.target;
    const url = isCreate
      ? `${input.baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`
      : `${input.baseUrl}/open-apis/im/v1/messages/${(input.target as { replyToMessageId: string }).replyToMessageId}/reply`;

    const res = await withRetry(() =>
      fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(isCreate ? { receive_id: (input.target as { chatId: string }).chatId } : {}),
          msg_type: "interactive",
          content: JSON.stringify(card),
        }),
      }),
      { maxRetries: 2, label: "feishu.cardkit.oversize_send" },
    );
    const json = (await res.json().catch(() => ({}))) as ApiResponse;
    if (!res.ok || (json.code != null && json.code !== 0)) {
      debugLog("feishu.cardkit.oversize_error", {
        status: res.status,
        code: json.code,
        msg: json.msg,
      });
      return false;
    }

    const messageId = json.data?.message_id;
    if (messageId) input.onOutboundMessageId?.(messageId);
    debugLog("feishu.cardkit.oversize_fallback_sent", {
      messageId,
      rawBytes: byteLength(progress),
      trimmedBytes: byteLength(trimmed),
      finalStatus: input.finalStatus,
    });
    return true;
  } catch (e) {
    debugLog("feishu.cardkit.oversize_throw", {
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}
