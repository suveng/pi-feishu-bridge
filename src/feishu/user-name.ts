/**
 * 飞书用户姓名解析（供 `[飞书提出人] ... name=张三` 使用）。
 *
 * 背景：`[飞书提出人]` 原来只有 open_id，事后完全看不出是谁提的
 * （`知识库` 的 `需求-归档.md` 里就写着「没有姓名映射」）。飞书的 contact API 能查到，
 * 但 name 属于**字段权限**：必须开 `contact:user.base:readonly`（或 `contact:contact:readonly`
 * 等同组权限），并且该用户要在应用的**通讯录权限范围**内，否则接口要么 code=0 却 name 为空，
 * 要么直接返回 41050 no user authority。
 *
 * 因此本模块的原则是**只增强、不阻塞**：查不到就返回 undefined，调用方原样降级回 open_id，
 * 绝不让「查名字」把消息处理拖垮或搞失败。
 */
import { debugLog } from "./debug.ts";
import type { Domain } from "./types.ts";

/** 姓名缓存有效期：6 小时（改昵称不会立刻生效，但不必每条消息都打接口） */
const NAME_TTL_MS = 6 * 60 * 60 * 1000;
/** 查不到时的短缓存：10 分钟（没开权限时不要每条消息都白打一次） */
const MISS_TTL_MS = 10 * 60 * 1000;
/** 单次查询超时：查名字绝不能拖慢消息处理 */
const LOOKUP_TIMEOUT_MS = 2000;

export type UserNameConfig = {
  appId: string;
  appSecret: string;
  domain?: Domain;
};

type CacheEntry = { name?: string; expires: number };

const nameCache = new Map<string, CacheEntry>();
let tokenCache: { token: string; expires: number } | undefined;

function baseUrl(domain?: Domain): string {
  return domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

/** 取 tenant_access_token（与应用内其它模块同口径，内部缓存到过期前 60 秒） */
async function getTenantToken(cfg: UserNameConfig, fetchImpl: typeof fetch): Promise<string> {
  if (tokenCache && tokenCache.expires > Date.now() + 60_000) return tokenCache.token;
  const res = await fetchImpl(`${baseUrl(cfg.domain)}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
  });
  const json = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
  if (json.code !== 0 || !json.tenant_access_token) {
    throw new Error(`tenant token 获取失败：${json.msg || res.status}`);
  }
  tokenCache = { token: json.tenant_access_token, expires: Date.now() + (json.expire ?? 7200) * 1000 };
  return tokenCache.token;
}

/** 本地超时包装（不引第三方依赖：查名字是可选增强，2 秒拿不到就放弃） */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 查飞书用户姓名。
 *
 * 查不到（没配应用凭证 / 缺字段权限 / 用户不在通讯录范围 / 网络失败 / 超时 / open_id 缺失）
 * 一律返回 undefined，**绝不抛异常**。
 */
export async function resolveUserName(
  openId: string | undefined,
  cfg: UserNameConfig | undefined,
  options?: { ttlMs?: number; timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<string | undefined> {
  const id = openId?.trim();
  if (!id || !cfg?.appId || !cfg.appSecret) return undefined;

  const cached = nameCache.get(id);
  if (cached && cached.expires > Date.now()) return cached.name;

  const ttlMs = options?.ttlMs ?? NAME_TTL_MS;
  const timeoutMs = options?.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  const fetchImpl = options?.fetchImpl ?? fetch;
  try {
    const token = await withTimeout(getTenantToken(cfg, fetchImpl), timeoutMs, "tenant token 超时");
    const res = await withTimeout(
      fetchImpl(`${baseUrl(cfg.domain)}/open-apis/contact/v3/users/${encodeURIComponent(id)}?user_id_type=open_id`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      timeoutMs,
      "查询用户信息超时",
    );
    const json = (await res.json()) as { code?: number; msg?: string; data?: { user?: { name?: string } } };
    const name = json.data?.user?.name?.trim() || undefined;
    if (!name) {
      // 两种典型：字段权限没开（code=0 但 name 为空）、用户不在通讯录权限范围（41050）
      debugLog("feishu.user_name.missing", { openId: id, code: json.code, msg: json.msg });
    }
    nameCache.set(id, { name, expires: Date.now() + (name ? ttlMs : Math.min(ttlMs, MISS_TTL_MS)) });
    return name;
  } catch (error) {
    debugLog("feishu.user_name.error", {
      openId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    // 失败也进短缓存，避免网络抖动时每条消息都卡 2 秒
    nameCache.set(id, { name: undefined, expires: Date.now() + Math.min(ttlMs, MISS_TTL_MS) });
    return undefined;
  }
}

/** 测试用：清空姓名与 token 缓存 */
export function resetUserNameCache(): void {
  nameCache.clear();
  tokenCache = undefined;
}
