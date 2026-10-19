/**
 * 飞书「发图片」能力 —— 之前桥接只会收图，不会发图。
 *
 * 触发方式：模型在正文里写 `![说明](/绝对/路径.png)`（或相对工作区路径），
 * 回复收尾时扫出来逐张上传并发送。这样 agent 生成/截图后不用让用户回电脑找文件。
 *
 * 飞书侧两步：
 *   1. POST /open-apis/im/v1/images（multipart，image_type=message）→ image_key
 *   2. POST /open-apis/im/v1/messages，msg_type=image，content={"image_key":...}
 * 需要的应用权限：「上传图片」（im:resource）。
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { debugLog } from "./debug.ts";

/** 能发出去的图片扩展名（飞书 image 消息支持的类型） */
const SUPPORTED_IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

/** 单张上限：飞书上传接口限制 10MB，超了直接跳过，不发报错卡 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 一轮最多发几张 —— 防止正文里一堆路径把消息刷屏 */
export const MAX_LOCAL_IMAGES_PER_TURN = 5;

export type LocalImageRef = { path: string; alt?: string };

export type ImageTarget = { replyToMessageId?: string; chatId?: string };

/**
 * 从正文里抽出「本地图片」引用。
 *
 * 只认 markdown 图片语法 `![alt](path)`，且 path 必须是本地文件、扩展名受支持、大小不超限。
 * http(s) / data: 链接一律跳过（那些飞书自己能渲染或根本不存在）。
 * 相对路径按 cwd 解析。
 */
export function extractLocalImages(text: string, cwd: string): LocalImageRef[] {
  if (!text) return [];
  const refs: LocalImageRef[] = [];
  const seen = new Set<string>();
  const re = /!\[([^\]]*)\]\(\s*([^)\s]+?)(?:\s+"[^"]*")?\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const rawPath = match[2]?.trim();
    if (!rawPath) continue;
    // 网络图片 / data URI 不归这里管
    if (/^[a-z][a-z0-9+.-]*:/i.test(rawPath)) continue;
    const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
    if (seen.has(abs)) continue;
    if (!SUPPORTED_IMAGE_EXT.has(extname(abs).toLowerCase())) continue;
    if (!existsSync(abs)) continue;
    try {
      if (statSync(abs).size > MAX_IMAGE_BYTES) continue;
    } catch {
      continue;
    }
    seen.add(abs);
    refs.push({ path: abs, alt: match[1] || undefined });
  }
  return refs;
}

/** 上传一张本地图片，返回 image_key（失败返回 undefined，不抛） */
export async function uploadImage(client: any, filePath: string): Promise<string | undefined> {
  try {
    const res = await client.im.image.create({
      data: { image_type: "message", image: createReadStream(filePath) },
    });
    const imageKey = res?.data?.image_key ?? res?.image_key;
    if (!imageKey) {
      debugLog("feishu.image.upload.empty_key", { filePath });
      return undefined;
    }
    return String(imageKey);
  } catch (error) {
    debugLog("feishu.image.upload.error", {
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * 上传并发送一张本地图片。
 *
 * target.replyToMessageId 优先（挂在回复链上，和文字对得上），否则平铺发到 chatId。
 * 返回新消息 ID；任一步失败返回 undefined —— 图片发不出去不该让整轮回复失败。
 */
export async function sendLocalImage(
  client: any,
  target: ImageTarget,
  filePath: string,
): Promise<string | undefined> {
  const imageKey = await uploadImage(client, filePath);
  if (!imageKey) return undefined;
  const content = JSON.stringify({ image_key: imageKey });
  try {
    if (target.replyToMessageId) {
      const res = await client.im.message.reply({
        path: { message_id: target.replyToMessageId },
        data: { msg_type: "image", content },
      });
      return res?.data?.message_id as string | undefined;
    }
    if (target.chatId) {
      const res = await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: target.chatId, msg_type: "image", content },
      });
      return res?.data?.message_id as string | undefined;
    }
  } catch (error) {
    debugLog("feishu.image.send.error", {
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return undefined;
}

/** 发图需要的最小 transport 面（与 ReplyCardTransport 的两个可选方法同形） */
export type LocalImageTransport = {
  replyLocalImage?(messageId: string, filePath: string): Promise<string | undefined>;
  sendLocalImage?(chatId: string, filePath: string): Promise<string | undefined>;
};

/**
 * 把正文里的本地图片挨张发出去，返回实际发出的张数。
 *
 * 规则：只在 status=done 时发（失败/中断的轮次不发）；失败只在日志里留痕。
 * 抽成 free function 是为了别把 reply-card.ts 顶过 500 行硬上限。
 */
export async function flushLocalImages(input: {
  body: string;
  status: "done" | "failed" | "stopped";
  target: ImageTarget;
  transport: LocalImageTransport;
  cwd?: string;
}): Promise<number> {
  if (input.status !== "done") return 0;
  const refs = extractLocalImages(input.body, input.cwd ?? process.cwd());
  if (refs.length === 0) return 0;
  const picked = refs.slice(0, MAX_LOCAL_IMAGES_PER_TURN);
  debugLog("feishu.reply_card.local_images", { count: picked.length, total: refs.length });
  let sent = 0;
  for (const ref of picked) {
    try {
      const id = input.target.replyToMessageId
        ? await input.transport.replyLocalImage?.(input.target.replyToMessageId, ref.path)
        : input.target.chatId
          ? await input.transport.sendLocalImage?.(input.target.chatId, ref.path)
          : undefined;
      if (id) sent += 1;
      debugLog("feishu.reply_card.local_image_sent", { path: ref.path, messageId: id });
    } catch (error) {
      debugLog("feishu.reply_card.local_image_error", {
        path: ref.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return sent;
}
