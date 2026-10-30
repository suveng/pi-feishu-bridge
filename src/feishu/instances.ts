import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WORKSPACE_INSTANCE_SUBPATH } from "./instance.ts";
import type { Domain, FeishuConfig, GroupPolicy } from "./types.ts";

/**
 * 一个工作区内「多个机器人」的实例目录约定。
 *
 * 架构基线不变（见 `instance.ts` 的说明）：**一个实例目录 = 一个自建应用 = 一个 daemon**。
 * 这份文件只负责「实例目录 ↔ 实例名」的映射与枚举，让 TUI 能在一个工作区里
 * 建/列/启停多个机器人，而不需要把单例的 `loadConfig()` / `FeishuTransport` 改成多例。
 *
 * 目录约定（都在工作区根下）：
 * - 默认实例：`<工作区>/.pi/feishu`，名字 `default`
 * - 其它实例：`<工作区>/.pi/feishu-<name>`
 *
 * 为什么不放在一个 daemon 里跑多连接：飞书长连接是集群模式不广播，
 * 每个 appId 一条连接、一把网关锁、一个回调端口；分进程是最小改动且故障隔离。
 */

export const DEFAULT_INSTANCE_NAME = "default";
export const INSTANCE_DIR_PREFIX = "feishu-";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;
/** 这些名字会跟默认实例的目录撞车或与「feishu-」前缀语义混淆，禁止使用。 */
const RESERVED_NAMES = new Set([DEFAULT_INSTANCE_NAME, "config", "state", "bridge", "dedupe", "daemon", "debug"]);

export type InstanceConfig = Partial<FeishuConfig> & { appId?: string; appSecret?: string };

export type InstanceSummary = {
  name: string;
  dir: string;
  configPath: string;
  configured: boolean;
  appId?: string;
  appSecret?: string;
  domain: Domain;
  groupPolicy?: GroupPolicy;
  autoStart: boolean;
  webhookPort?: number;
};

/** 实例名合法性：小写字母/数字/连字符，首字符必须是字母或数字。 */
export function isValidInstanceName(name: string): boolean {
  return NAME_PATTERN.test(name) && !RESERVED_NAMES.has(name);
}

/** 实例名 → 实例目录（默认实例是 `.pi/feishu`，其余是 `.pi/feishu-<name>`）。 */
export function instanceDirForName(workspaceRoot: string, name: string = DEFAULT_INSTANCE_NAME): string {
  const root = resolve(workspaceRoot);
  if (name === DEFAULT_INSTANCE_NAME) return join(root, WORKSPACE_INSTANCE_SUBPATH);
  const dirName = `${INSTANCE_DIR_PREFIX}${name}`;
  return join(root, ".pi", dirName);
}

/** 实例目录 → 实例名；不是本工作区约定内的实例目录时返回 `undefined`。 */
export function instanceNameFromDir(workspaceRoot: string, dir: string): string | undefined {
  const root = resolve(workspaceRoot);
  const target = resolve(dir);
  if (target === join(root, WORKSPACE_INSTANCE_SUBPATH)) return DEFAULT_INSTANCE_NAME;
  const prefix = `${join(root, ".pi")}/`;
  if (!target.startsWith(prefix)) return undefined;
  const dirName = target.slice(prefix.length);
  if (!dirName.startsWith(INSTANCE_DIR_PREFIX)) return undefined;
  const name = dirName.slice(INSTANCE_DIR_PREFIX.length);
  return isValidInstanceName(name) ? name : undefined;
}

export function instanceConfigPath(dir: string): string {
  return join(dir, "config.pi.json");
}

/**
 * 读任意实例目录的配置（**纯读**，与模块级 `ROOT_DIR` 无关）。
 * 不存在 / 解析失败 / 缺 appId 或 appSecret 时返回 `undefined`。
 */
export function readInstanceConfig(dir: string): InstanceConfig | undefined {
  const path = instanceConfigPath(dir);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const cfg = parsed as InstanceConfig;
  const appId = typeof cfg.appId === "string" ? cfg.appId.trim() : "";
  const appSecret = typeof cfg.appSecret === "string" ? cfg.appSecret.trim() : "";
  if (!appId || !appSecret) return undefined;
  return { ...cfg, appId, appSecret };
}

/** 只读 appId（连接锁按 appId 区分，判归属时不需要 secret）。 */
export function readInstanceAppId(dir: string): string | undefined {
  return readInstanceConfig(dir)?.appId;
}

/**
 * 枚举工作区里所有实例（含未配置的目录）。
 * 排序：默认实例在首位，其余按名字。
 */
export function listInstances(workspaceRoot: string = process.cwd()): InstanceSummary[] {
  const root = resolve(workspaceRoot);
  const piDir = join(root, ".pi");
  const found: InstanceSummary[] = [];
  const names = new Set<string>([DEFAULT_INSTANCE_NAME]);

  let entries: string[] = [];
  try {
    entries = readdirSync(piDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.startsWith(INSTANCE_DIR_PREFIX)) continue;
    const name = entry.slice(INSTANCE_DIR_PREFIX.length);
    if (isValidInstanceName(name)) names.add(name);
  }

  for (const name of names) {
    const dir = instanceDirForName(root, name);
    const cfg = readInstanceConfig(dir);
    const configured = Boolean(cfg);
    // 未配置的目录只有真的存在才算一个实例（否则「default 从未 setup」也会列出来）
    if (!configured && !existsSync(dir)) continue;
    found.push({
      name,
      dir,
      configPath: instanceConfigPath(dir),
      configured,
      appId: cfg?.appId,
      appSecret: cfg?.appSecret,
      domain: (cfg?.domain as Domain) || "feishu",
      groupPolicy: cfg?.groupPolicy,
      autoStart: cfg?.autoStart !== false,
      webhookPort: typeof cfg?.cardActionWebhookPort === "number" ? cfg.cardActionWebhookPort : undefined,
    });
  }

  return found.sort((a, b) => {
    if (a.name === DEFAULT_INSTANCE_NAME) return -1;
    if (b.name === DEFAULT_INSTANCE_NAME) return 1;
    return a.name.localeCompare(b.name);
  });
}
