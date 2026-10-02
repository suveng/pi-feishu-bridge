/**
 * 飞书交互卡片回调的统一处理（/model、/thinking、/resume、停止按钮、复制按钮）。
 * 只依赖 ConversationRuntime 接口与飞书公共层，各 Runtime 适配器直接复用。
 */
import { buildCardKitCardJson } from "./card-builder.ts";
import { answerAsk, askInputName, buildAskCard, type AskSettleStatus } from "./ask.ts";
import {
  buildDeliveryCard,
  buildModelCard,
  buildResumeCard,
  buildThinkingCard,
  parseDeliveryActionValue,
  parseModelActionValue,
  parseResumePageActionValue,
  parseResumeSelectActionValue,
  parseThinkingActionValue,
} from "./cards.ts";
import { debugLog } from "./debug.ts";
import { loadConfig } from "./config.ts";
import { setRuntimeConfig } from "./runtime-config.ts";
import { parseStopTaskActionValue } from "./reply-card.ts";
import type { ConversationRuntime } from "./runtime.ts";
import type { FeishuTransport } from "./transport.ts";
import type { FeishuCardAction } from "./types.ts";

export function createCardActionHandler(
  conversations: ConversationRuntime,
  getTransport: () => FeishuTransport | undefined,
) {
  return async (action: FeishuCardAction) => {
    const transport = getTransport();

    // feishu_ask 选择题：记录答案并原地刷新同一张卡
    const askAnswer = parseAskAnswerActionValue(action.value);
    if (askAnswer) {
      const result = answerAsk(askAnswer.askId, askAnswer.questionIndex, askAnswer.label);
      if (!result.found || !result.record) return;
      // 迟到的点击：这条提问已经结算（答完 / 超时 / 取消），本次点击不生效。
      // 必须刷卡片 + 回一句文本，否则用户看到的是「点了没反应」的僵尸卡片。
      if (result.settled) {
        debugLog("feishu.ask.click_after_settled", {
          askId: askAnswer.askId,
          questionIndex: askAnswer.questionIndex,
          label: askAnswer.label,
          status: result.settledStatus,
        });
        await transport?.replyPlainText(action.messageId, settledAskNotice(result.settledStatus));
        return buildAskCard(
          result.record.askId,
          result.record.questions,
          result.record.answers,
          settledCardStatus(result.settledStatus),
        );
      }
      debugLog("feishu.ask.clicked", {
        askId: askAnswer.askId,
        questionIndex: askAnswer.questionIndex,
        label: askAnswer.label,
        allAnswered: result.allAnswered,
      });
      return buildAskCard(
        askAnswer.askId,
        result.record.questions,
        result.record.answers,
        result.allAnswered ? "done" : "pending",
      );
    }

    // feishu_ask 自由输入：表单容器提交时，输入值在 action.formValue 里（key = 输入框 name）
    const askInput = parseAskInputActionValue(action.value);
    if (askInput) {
      const text = readFormInput(action.formValue, askInputName(askInput.questionIndex));
      const result = answerAsk(askInput.askId, askInput.questionIndex, text, true);
      if (!result.found || !result.record) return;
      // 同上：已结算的提问再提交，给明确提示而不是静默丢弃
      if (result.settled) {
        debugLog("feishu.ask.input_after_settled", {
          askId: askInput.askId,
          questionIndex: askInput.questionIndex,
          status: result.settledStatus,
        });
        await transport?.replyPlainText(action.messageId, settledAskNotice(result.settledStatus));
        return buildAskCard(
          result.record.askId,
          result.record.questions,
          result.record.answers,
          settledCardStatus(result.settledStatus),
        );
      }
      debugLog("feishu.ask.input_submitted", {
        askId: askInput.askId,
        questionIndex: askInput.questionIndex,
        textLength: text.trim().length,
        accepted: result.accepted,
        allAnswered: result.allAnswered,
      });
      return buildAskCard(
        askInput.askId,
        result.record.questions,
        result.record.answers,
        result.allAnswered ? "done" : "pending",
      );
    }

    const copy = parseCopyMarkdownActionValue(action.value);
    if (copy) {
      const source = transport?.getMarkdownCopySource(copy.copySourceId);
      await transport?.replyPlainText(action.messageId, source || "MD 原文已过期，请重新生成卡片。");
      return;
    }

    const stopTask = parseStopTaskActionValue(action.value);
    if (stopTask) {
      debugLog("feishu.card.stop_requested", {
        key: stopTask.key,
        runId: stopTask.runId,
        cardMessageId: action.messageId,
        chatId: action.chatId,
      });
      // 停止时由 ReplyCard.stopImmediately 更新同一张卡；回调不再另发文本
      const result = await conversations.stopConversation(stopTask.key, async () => undefined, stopTask.runId);
      const status = result.status === "stopped"
        ? "stopped"
        : result.status === "failed"
          ? "failed"
          : "inactive";
      debugLog("feishu.card.stop_final_update_done", {
        key: stopTask.key,
        runId: stopTask.runId,
        cardMessageId: action.messageId,
        result: result.status,
      });
      // CardKit 流式卡是 schema 2.0；回调必须返回 2.0，否则会 200830/200671
      // body 优先用 cardkit.close() 已写入的累计文本，避免覆盖已输出内容
      // progress 同理：不带的话，回调返回的卡会把刚看到的执行清单刷没
      return buildCardKitCardJson({
        status,
        body: "body" in result ? result.body : result.message || "已停止",
        key: stopTask.key,
        runId: stopTask.runId,
        streaming: false,
        progress: "progress" in result ? result.progress : undefined,
      });
    }

    const resumePage = parseResumePageActionValue(action.value);
    if (resumePage) {
      const page = await conversations.listResumeSessions(resumePage.key, resumePage.scope, resumePage.page);
      return buildResumeCard(page);
    }

    const resumeSelect = parseResumeSelectActionValue(action.value);
    if (resumeSelect) {
      await conversations.resumeConversation(resumeSelect.key, resumeSelect.sessionPath, async (reply) => {
        await transport?.replyText(action.messageId, reply);
      });
      const page = await conversations.listResumeSessions(resumeSelect.key, resumeSelect.scope, resumeSelect.page);
      return buildResumeCard(page);
    }

    const selectedThinking = parseThinkingActionValue(action.value);
    if (selectedThinking) {
      await conversations.selectThinkingLevel(selectedThinking.key, selectedThinking.level, async (reply) => {
        await transport?.replyText(action.messageId, reply);
      });
      const [currentModel, thinking] = await Promise.all([
        conversations.getSelectedModel(selectedThinking.key),
        conversations.getThinkingStatus(selectedThinking.key),
      ]);
      return buildThinkingCard(selectedThinking.key, currentModel, thinking);
    }

    const selectedDelivery = parseDeliveryActionValue(action.value);
    if (selectedDelivery) {
      const set = setRuntimeConfig("messageDelivery", selectedDelivery.mode);
      if (set.ok === false) {
        await transport?.replyText(action.messageId, `❌ ${set.error}`);
      } else {
        debugLog("feishu.delivery.changed", { mode: selectedDelivery.mode });
      }
      // 原地刷新同一张卡片，让当前值立刻可见
      return buildDeliveryCard(loadConfig()?.messageDelivery);
    }

    const selected = parseModelActionValue(action.value);
    if (!selected) return;
    await conversations.selectModel(selected.key, selected.provider, selected.modelId, async (reply) => {
      await transport?.replyText(action.messageId, reply);
    });
    const models = await conversations.getAvailableModels();
    const currentModel = await conversations.getSelectedModel(selected.key);
    return buildModelCard(selected.key, models, currentModel);
  };
}

/** 已结算提问被再点时的卡片状态：答完保持绿，超时 / 已结束走灰 */
function settledCardStatus(status: AskSettleStatus | undefined): "done" | "timeout" | "canceled" {
  if (status === "done") return "done";
  return status === "canceled" ? "canceled" : "timeout";
}

/** 已结算提问被再点时的文本提示：卡片刷新之外再交代一句，让用户不用猜 */
function settledAskNotice(status: AskSettleStatus | undefined): string {
  if (status === "done") return "✅ 这个问题已经答过了，本次点击未生效。";
  if (status === "timeout") return "⌛ 这个提问已超时，本次点击不会生效。需要的话让 Agent 重新问一次。";
  return "⚠️ 这个提问已结束，本次点击未生效。需要的话让 Agent 重新问一次。";
}

function parseAskAnswerActionValue(value: unknown): { askId: string; questionIndex: number; label: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_ask_answer") return undefined;
  if (typeof raw.askId !== "string" || !raw.askId) return undefined;
  if (!Number.isInteger(raw.questionIndex)) return undefined;
  if (typeof raw.label !== "string" || !raw.label) return undefined;
  return { askId: raw.askId, questionIndex: raw.questionIndex, label: raw.label };
}

function parseAskInputActionValue(value: unknown): { askId: string; questionIndex: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_ask_input") return undefined;
  if (typeof raw.askId !== "string" || !raw.askId) return undefined;
  if (!Number.isInteger(raw.questionIndex)) return undefined;
  return { askId: raw.askId, questionIndex: raw.questionIndex };
}

/** 取表单容器提交的输入框文本；缺失或非字符串一律当空串 */
function readFormInput(formValue: unknown, name: string): string {
  if (!formValue || typeof formValue !== "object") return "";
  const value = (formValue as Record<string, unknown>)[name];
  return typeof value === "string" ? value : "";
}

function parseCopyMarkdownActionValue(value: unknown): { copySourceId: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_copy_markdown") return undefined;
  if (typeof raw.copySourceId !== "string" || !raw.copySourceId) return undefined;
  return { copySourceId: raw.copySourceId };
}
