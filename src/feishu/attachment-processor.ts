/**
 * 附件处理（图片 / 压缩包 / 文本文件），从 message-handler.ts 拆出来。
 *
 * 为什么单独一个文件：message-handler.ts 原本 586 行，已超单文件 500 行硬上限；
 * 附件分流是其中最大的一块（111 行）且与消息路由无关，机械搬出来不承担额外风险。
 *
 * 分流原则：
 * - 图片 → base64 直接给支持视觉的模型；
 * - 压缩包 → 落盘到收件箱，agent 自己解压（日志包动辄几十 MB，塞进上下文只会被截断）；
 * - 其余按扩展名判断是否是可解码文本，能解码就贴进 prompt，否则报「类型不支持」。
 */
import {
  buildArchiveSection,
  decodeTextFile,
  detectCodeLanguage,
  detectImageMime,
  isArchiveFile,
  isSupportedImageMime,
  isSupportedTextFile,
  saveArchiveToInbox,
  type FeishuImageInput,
} from "./attachments.ts";
import { debugLog } from "./debug.ts";
import type { FeishuTransport } from "./transport.ts";
import type { FeishuMessage } from "./types.ts";

/** 从飞书消息里解析出的附件（图片用 image_key，文件用 file_key） */
export type AttachmentInput = { kind: "image" | "file"; fileKey: string; fileName?: string };

/** 附件处理结果：图片喂模型、文件段落贴进 prompt、失败原因回给用户 */
export type ProcessedAttachments = {
  imageInputs: FeishuImageInput[];
  fileSections: string[];
  downloadErrors: string[];
  skippedImageCount: number;
};

export async function processAttachments(
  msg: FeishuMessage,
  attachments: AttachmentInput[],
  modelSupportsImage: boolean,
  transport: FeishuTransport | undefined,
): Promise<ProcessedAttachments> {
  const imageInputs: FeishuImageInput[] = [];
  const fileSections: string[] = [];
  const downloadErrors: string[] = [];
  let skippedImageCount = 0;

  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      if (!modelSupportsImage) {
        skippedImageCount += 1;
        continue;
      }
      if (!transport) {
        downloadErrors.push("飞书连接不可用，图片无法下载");
        continue;
      }
      try {
        const resource = await withTimeout(
          transport.downloadImage(msg.messageId, attachment.fileKey),
          15000,
          "图片下载超时",
        );
        const mimeType = detectImageMime(resource.bytes, resource.mimeType);
        if (!isSupportedImageMime(mimeType)) {
          downloadErrors.push("图片格式暂不支持（仅支持 png/jpg/webp）");
          continue;
        }
        imageInputs.push({
          type: "image",
          data: resource.bytes.toString("base64"),
          mimeType,
        });
      } catch (error) {
        debugLog("feishu.handler.image_error", {
          messageId: msg.messageId,
          fileKey: attachment.fileKey,
          error: error instanceof Error ? error.message : String(error),
        });
        downloadErrors.push(error instanceof Error ? error.message : "图片下载失败");
      }
      continue;
    }

    const fileName = attachment.fileName || "unnamed";

    // 压缩包：落盘给 agent 自己解压，不塞进 prompt（日志包太大，塞进去只会被截断）
    if (isArchiveFile(fileName)) {
      if (!transport) {
        downloadErrors.push(`飞书连接不可用，压缩包无法下载：${fileName}`);
        continue;
      }
      try {
        // 压缩包可能很大，下载超时比普通文件放宽
        const resource = await withTimeout(
          transport.downloadMessageResource(msg.messageId, attachment.fileKey, "file"),
          60000,
          `压缩包下载超时：${fileName}`,
        );
        const savedPath = saveArchiveToInbox(msg.messageId, fileName, resource.bytes);
        debugLog("feishu.handler.archive_saved", {
          messageId: msg.messageId,
          fileKey: attachment.fileKey,
          path: savedPath,
          bytes: resource.bytes.length,
        });
        fileSections.push(buildArchiveSection(fileName, savedPath, resource.bytes.length));
      } catch (error) {
        debugLog("feishu.handler.archive_error", {
          messageId: msg.messageId,
          fileKey: attachment.fileKey,
          error: error instanceof Error ? error.message : String(error),
        });
        downloadErrors.push(error instanceof Error ? error.message : `压缩包下载失败：${fileName}`);
      }
      continue;
    }

    if (!isSupportedTextFile(fileName)) {
      downloadErrors.push(`文件类型不支持：${fileName}`);
      continue;
    }
    if (!transport) {
      downloadErrors.push(`飞书连接不可用，文件无法下载：${fileName}`);
      continue;
    }
    try {
      const resource = await withTimeout(
        transport.downloadMessageResource(msg.messageId, attachment.fileKey, "file"),
        15000,
        `文件下载超时：${fileName}`,
      );
      const decoded = decodeTextFile(fileName, resource.bytes);
      if (!decoded.ok) {
        downloadErrors.push(`文件无法按文本读取：${fileName}`);
        continue;
      }
      const language = detectCodeLanguage(fileName);
      const suffix = decoded.truncated ? "\n[内容过长，已截断]" : "";
      fileSections.push(`[Feishu file: ${fileName}]\n\`\`\`${language}\n${decoded.text}${suffix}\n\`\`\``);
    } catch (error) {
      downloadErrors.push(error instanceof Error ? error.message : `文件下载失败：${fileName}`);
    }
  }

  return { imageInputs, fileSections, downloadErrors, skippedImageCount };
}

/** 给单个下载加超时：飞书资源接口偶发挂住，不能让它拖死整轮回复 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
