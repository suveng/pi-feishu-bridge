import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * 多实例（同一台机器上跑多个工作区 / 多个机器人）的路径与端口解析。
 *
 * 隔离轴只有一个：**实例数据目录**（环境变量 `FEISHU_DATA_DIR`）。
 * - 不设：主实例，所有路径与端口保持旧版行为（完全向后兼容）。
 * - 设了：配置、状态、桥接路由、去重记录、日志、附件收件箱、卡片回调端口
 *   全部落到该目录，与主实例（以及其他实例）互不干扰。
 *
 * 刻意**不**隔离的东西：连接锁（见 `gateway-lock.ts`）。
 * 锁按 appId 全局互斥是护栏，不是缺陷 —— 飞书长连接是集群模式、不广播，
 * 同一个机器人的事件只会随机推给其中一条连接，两个实例共用同一个 appId
 * 会互相抢连接、并让消息随机落到错误的工作区。
 * 所以多开的前提是「一个工作区一个机器人（各自的 appId）」。
 */

/** 默认（主实例）数据目录：不设 `FEISHU_DATA_DIR` 时的行为等同于旧版本。 */
export const DEFAULT_ROOT_DIR = join(homedir(), ".pi", "agent", "feishu");

/** 卡片回调默认端口区间：3001/3002 已被主实例的 Pi / DSH 占用，多实例从 3003 起。 */
const INSTANCE_PORT_BASE = 3003;
const INSTANCE_PORT_SPAN = 97;

/** 展开开头的 `~` / `~/`；其余原样交给 path.resolve 处理。 */
function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

/**
 * 解析实例数据目录。未配置或配置为空串时返回 `undefined`（表示主实例）。
 * 相对路径按当前工作目录解析，但多开场景请一律传绝对路径，避免 daemon 的
 * cwd 变化后指向不同目录。
 */
export function resolveInstanceDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.FEISHU_DATA_DIR?.trim();
  if (!raw) return undefined;
  return resolve(expandHome(raw));
}

/** 解析 Feishu 数据根目录：设了实例目录就用它，否则用默认主实例目录。 */
export function resolveRootDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveInstanceDir(env) ?? DEFAULT_ROOT_DIR;
}

/**
 * 解析 Harness（DSH）数据根目录。默认仍在 `~/.dsh/feishu`；
 * 一旦启用实例目录，则挪到 `<实例目录>/harness`，保证同一工作区里
 * Pi 与 DSH 两个 runtime 的文件也一起被隔离。
 */
export function resolveHarnessRoot(defaultDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = resolveInstanceDir(env);
  return dir ? join(dir, "harness") : defaultDir;
}

/**
 * 解析卡片回调默认端口。
 * - 主实例：沿用 base（Pi 3001 / DSH 3002）。
 * - 多实例：按「实例目录 + base」稳定派生到 3003-3099 区间 —— 同一目录每次启动
 *   得到同一个端口（飞书后台的回调地址只需配一次），不同目录互不相同。
 * 派生只是尽力而为（区间内存在理论碰撞），需要精确控制时用
 * `FEISHU_CARD_ACTION_WEBHOOK_PORT` 显式指定，显式值优先级更高。
 */
export function instanceWebhookPort(base: number, env: NodeJS.ProcessEnv = process.env): number {
  const dir = resolveInstanceDir(env);
  if (!dir) return base;
  const digest = createHash("sha1").update(`${dir}:${base}`).digest();
  return INSTANCE_PORT_BASE + (digest.readUInt16BE(0) % INSTANCE_PORT_SPAN);
}

/** 目录比较用的归一化：先展开 `~` 再取 realpath（软链、`/tmp` vs `/private/tmp` 视为同一处）；
 * 目录已不存在时退回字面 resolve，保证纯函数在任何环境下都能给出确定结果。 */
function normalizeDir(dir: string): string {
  const expanded = resolve(expandHome(dir));
  try {
    return realpathSync(expanded);
  } catch {
    return expanded;
  }
}

/**
 * 是否「裸开复用了别的实例的全局配置」——自动启动前的保险。
 *
 * 三条件同时成立才算：
 * 1. 本进程**没做实例隔离**（未设 `FEISHU_DATA_DIR`，走全局默认目录）；
 * 2. 这份全局配置对应的连接锁已有 owner（能读到 owner 的 cwd）；
 * 3. owner 的 cwd 与当前 cwd 归一化后**不是同一个目录**。
 *
 * 含义：这份全局配置（同一个机器人）属于**另一个工作区**。飞书长连接是集群模式、不广播，
 * 两个实例共用同一个 appId 会互相抢连接，并让消息随机落到错的工作区，
 * 因此调用方应拒绝自动启动，改为提示用户走实例目录 + 独立自建应用。
 *
 * 判据有两个来源，任一指向别的目录就算外来：
 * 1. 连接锁当前 owner 的 cwd（锁被持时有效）；
 * 2. 属主工作区记录（`owner-workspace.json`）—— 锁空闲时靠它才能分辨归属。
 *
 * 确需在别的目录临时接管时，设 `FEISHU_ALLOW_FOREIGN_WORKSPACE=1` 显式放行，
 * 或在那个目录手动 `/feishu restart`（手动操作不受本保护限制，并会更新属主记录）。
 */
export function isForeignWorkspace(
  ownerCwd: string | undefined | null,
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  recordedOwnerCwd?: string | null,
): boolean {
  if (resolveInstanceDir(env)) return false;
  if (env.FEISHU_ALLOW_FOREIGN_WORKSPACE === "1") return false;
  const mine = normalizeDir(cwd);
  const owners = [ownerCwd, recordedOwnerCwd].filter((value): value is string => Boolean(value?.trim()));
  if (owners.length === 0) return false;
  return owners.some((owner) => normalizeDir(owner) !== mine);
}

/** 属主工作区记录文件名（放在实例根目录下）：标明这份实例属于哪个工作区。 */
export const OWNER_WORKSPACE_FILE = "owner-workspace.json";

/** 属主工作区记录文件的完整路径。 */
export function ownerWorkspacePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveRootDir(env), OWNER_WORKSPACE_FILE);
}

/**
 * 读属主工作区记录（缺文件 / 格式不对 / 字段为空都返回 `undefined`）。
 * 这份记录是「裸开保护」在锁空闲时的唯一判据：连接锁只记录了*当前*持有者，
 * 而记录记的是这份配置**长期属于谁**。
 */
export function readOwnerWorkspace(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(ownerWorkspacePath(env), "utf8")) as { cwd?: unknown };
    return typeof parsed.cwd === "string" && parsed.cwd.trim() ? parsed.cwd : undefined;
  } catch {
    return undefined;
  }
}

/** 把当前目录认领为属主工作区（连接成功后调用；写失败只意味着少了这道保险，不影响主流程）。 */
export function writeOwnerWorkspace(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): void {
  try {
    const file = ownerWorkspacePath(env);
    mkdirSync(dirname(file), { recursive: true });
    const payload = { cwd: normalizeDir(cwd), updatedAt: new Date().toISOString() };
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch {
    // 忽略：记录写不进去也不该阻断连接
  }
}
