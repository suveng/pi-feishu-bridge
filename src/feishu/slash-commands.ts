/**
 * 飞书「斜杠指令」（Slash Command）注册。
 *
 * 作用：把桥接已支持的命令注册到飞书开放平台，用户在聊天输入框敲 `/`
 * 即可看到指令提示面板（命令文本会留在输入框，可继续补参数再发送）。
 *
 * 官方接口：/open-apis/application/v7/app_slash_commands（需 tenant_access_token）
 * 所需权限：application:app_slash_command:write（读列表用 read / write 均可）
 *
 * 设计要点：
 * - 幂等：先查列表，缺的 POST，描述有变化才 PATCH，其余跳过。
 * - 静默降级：权限缺失、应用未发布、平台报错时只写调试日志，绝不抛出，
 *   以免影响扫码建应用 / 桥接启动主流程。
 * - 客户端有缓存（注册约 5 分钟 + 客户端缓存约 3 分钟），失败后无需反复重试。
 */
import { debugLog } from "./debug.ts";
import type { FeishuConfig } from "./types.ts";

/** 单条指令定义：command 不含前导斜杠 */
export type SlashCommandSpec = {
  /** 指令名（不含 `/`），须与 parseBotCommand 识别的名字一致 */
  command: string;
  /** 中文描述（description.default_value 与 i18n.zh_cn） */
  zh: string;
  /** 英文描述（i18n.en_us） */
  en: string;
};

/**
 * 与 messages.ts 的 parseBotCommand / getCommandList 保持一致的指令清单。
 * 注意：不传 icon（icon_key 取值受平台约束，传错会触发参数校验失败）。
 */
export const FEISHU_SLASH_COMMANDS: SlashCommandSpec[] = [
  { command: "new", zh: "新建会话", en: "Start a new conversation" },
  { command: "resume", zh: "恢复历史会话", en: "Resume a previous conversation" },
  { command: "model", zh: "切换模型", en: "Switch model" },
  { command: "thinking", zh: "调整思考强度", en: "Adjust thinking level" },
  { command: "workspace", zh: "切换工作区（后接绝对路径）", en: "Switch workspace (absolute path)" },
  { command: "status", zh: "查看会话状态", en: "Show session status" },
  { command: "stop", zh: "停止当前生成", en: "Stop the current reply" },
  { command: "config", zh: "查看或修改运行时配置（仅私聊）", en: "View or update runtime config (private chat only)" },
  { command: "commands", zh: "显示全部命令", en: "List all commands" },
  { command: "restart", zh: "重启桥接进程并加载最新代码（保留会话上下文）", en: "Restart the bridge and reload code (session kept)" },
  // interrupt 模式为 Pi 侧实现
  { command: "delivery", zh: "设置「正在生成时又收到新消息」怎么处理（排队 / 立即打断，仅私聊）", en: "How to handle new messages while replying (queue / interrupt, DM only)" },
  // --- 由 Pi 侧扩展（knowledge-flow）注册的命令 ---
  // 面板的作用是「提示用户有哪些命令可用」：飞书斜杠指令点击后只是把命令文本
  // 插进输入框（不会自动执行），用户补完参数再发送。所以这里保留全部命令，
  // 与实际是否派发无关（派发策略见 PiConversationRuntime 的 DISPATCHED_SLASH_COMMANDS）。
  // 注意：command 必须匹配 ^[a-z][a-z0-9_-]{0,31}$（实测 code 40000000），
  // 所以 Pi 侧的中文命令名（如原先的 /学习）无法注册，统一改用英文名 /learn。
  { command: "req", zh: "需求流程：/req [新 <名称>|开发|测试|bug|归档|状态] [需求ID]", en: "Requirement flow: /req [new|dev|test|bug|archive|status]" },
  { command: "kb", zh: "知识库：/kb [查|梳理|新模块|新功能|同步|巡检]", en: "Knowledge base: /kb [find|outline|new-module|new-feature|sync|audit]" },
  { command: "test", zh: "测试域：/test [新用例|缺口|同步|查|状态]", en: "Test domain: /test [new-case|gaps|sync|find|status]" },
  { command: "learn", zh: "学习：把反馈落成 .pi/ 下的规范改动（无参数则复盘本会话）", en: "Learn: turn feedback into .pi spec changes (no args = review this session)" },
  { command: "deploy-test", zh: "测试环境部署：/deploy-test [端名]，端名如 rust_server / quasar / quasar_h5", en: "Deploy test env: /deploy-test [target]" },
];

const API_PATH = "/open-apis/application/v7/app_slash_commands";
/** 单次同步最多翻页次数，防止异常分页导致死循环 */
const MAX_PAGES = 10;
const PAGE_SIZE = 100;

/** 同一进程内只自动同步一次，避免热重连时反复调接口 */
let autoSyncDone = false;

export type SyncSlashCommandsResult = {
  ok: boolean;
  created: string[];
  updated: string[];
  skipped: string[];
  /** ok=false 时的可读原因（权限不足 / 应用未发布 / 网络错误等） */
  reason?: string;
};

type ApiResponse = {
  code?: number;
  msg?: string;
  data?: {
    items?: Array<{
      command_id?: string;
      command?: string;
      description?: CommandDescription;
    }>;
    page_token?: string;
    has_more?: boolean;
  };
};

type CommandDescription = {
  default_value?: string;
  i18n?: Record<string, string>;
};

/** 平台返回 code !== 0 时统一转成可读错误 */
function assertOk(res: ApiResponse, action: string) {
  if (res && typeof res.code === "number" && res.code !== 0) {
    throw new Error(`${action} failed: code=${res.code} msg=${res.msg || ""}`);
  }
}

function buildDescription(spec: SlashCommandSpec, language: "zh" | "en"): CommandDescription {
  return {
    default_value: language === "en" ? spec.en : spec.zh,
    i18n: { zh_cn: spec.zh, en_us: spec.en },
  };
}

/** 已注册描述与目标描述是否一致（不一致才 PATCH） */
function descriptionMatches(existing: CommandDescription | undefined, target: CommandDescription) {
  if (!existing) return false;
  if ((existing.default_value || "") !== (target.default_value || "")) return false;
  const existingI18n = existing.i18n || {};
  const targetI18n = target.i18n || {};
  return (existingI18n.zh_cn || "") === (targetI18n.zh_cn || "")
    && (existingI18n.en_us || "") === (targetI18n.en_us || "");
}

/** 拉取当前应用已注册的全部指令，返回 command -> 记录 的映射 */
async function listExistingCommands(client: any): Promise<Map<string, { commandId: string; description?: CommandDescription }>> {
  const found = new Map<string, { commandId: string; description?: CommandDescription }>();
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params: Record<string, string> = { page_size: String(PAGE_SIZE) };
    if (pageToken) params.page_token = pageToken;
    const res: ApiResponse = await client.request({ url: API_PATH, method: "GET", params });
    assertOk(res, "list slash commands");

    for (const item of res?.data?.items || []) {
      if (!item?.command) continue;
      found.set(String(item.command), {
        commandId: String(item.command_id || ""),
        description: item.description,
      });
    }

    pageToken = res?.data?.page_token;
    if (!res?.data?.has_more || !pageToken) break;
  }

  return found;
}

/**
 * 同步斜杠指令到飞书平台（幂等）。
 * 调用方应当 fire-and-forget，并自行 catch；本函数内部也会兜住异常。
 */
export async function syncSlashCommands(
  client: any,
  config: FeishuConfig,
  options?: { commands?: SlashCommandSpec[] },
): Promise<SyncSlashCommandsResult> {
  const specs = options?.commands || FEISHU_SLASH_COMMANDS;
  const language: "zh" | "en" = config?.language === "en" ? "en" : "zh";
  const result: SyncSlashCommandsResult = { ok: false, created: [], updated: [], skipped: [] };

  if (!client || typeof client.request !== "function") {
    result.reason = "lark client unavailable";
    debugLog("feishu.slash.skipped", { reason: result.reason });
    return result;
  }

  try {
    const existing = await listExistingCommands(client);
    debugLog("feishu.slash.remote_list", { count: existing.size, commands: [...existing.keys()] });

    for (const spec of specs) {
      const target = buildDescription(spec, language);
      const current = existing.get(spec.command);

      if (!current) {
        const res: ApiResponse = await client.request({
          url: API_PATH,
          method: "POST",
          data: { command: spec.command, description: target },
        });
        assertOk(res, `create ${spec.command}`);
        result.created.push(spec.command);
        debugLog("feishu.slash.created", { command: spec.command });
        continue;
      }

      if (!current.commandId) {
        result.skipped.push(spec.command);
        continue;
      }

      if (descriptionMatches(current.description, target)) {
        result.skipped.push(spec.command);
        continue;
      }

      const res: ApiResponse = await client.request({
        url: `${API_PATH}/${current.commandId}`,
        method: "PATCH",
        data: { description: target },
      });
      assertOk(res, `update ${spec.command}`);
      result.updated.push(spec.command);
      debugLog("feishu.slash.updated", { command: spec.command, commandId: current.commandId });
    }

    result.ok = true;
    debugLog("feishu.slash.synced", {
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.reason = message;
    // 典型原因：应用未开通 application:app_slash_command:write，或应用未发布。
    result.ok = false;
    debugLog("feishu.slash.sync_failed", {
      error: message,
      hint: "需要在飞书开发者后台为应用开通 application:app_slash_command:write 权限并发布版本",
    });
    return result;
  }
}

/**
 * 桥接启动时调用一次：后台同步，不阻塞 WS 建连。
 * 失败只记日志，可通过 /feishu debug 查看。
 */
export function autoSyncSlashCommands(client: any, config: FeishuConfig) {
  if (autoSyncDone) return;
  autoSyncDone = true;
  void syncSlashCommands(client, config).catch(() => {
    // syncSlashCommands 内部已兜住异常，这里只是双保险
  });
}

/** 单测/热重载场景下重置自动同步标记 */
export function resetSlashAutoSyncFlag() {
  autoSyncDone = false;
}
