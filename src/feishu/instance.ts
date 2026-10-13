import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * 实例数据目录与卡片回调端口的解析。
 *
 * **实例目录跟着工作区走**：默认就是工作区自己的 `<工作区根>/.pi/feishu`，
 * 不存在「全局实例」——每个工作区的配置、状态、桥接路由、去重记录、日志、附件收件箱
 * 都落在自己目录里，互不干扰。`FEISHU_DATA_DIR` 仍可作为显式覆盖（少数要把数据
 * 放到别处的场景），优先级高于默认值。
 *
 * 0.6.0 之前默认是全局的 `~/.pi/agent/feishu`（见 `LEGACY_GLOBAL_ROOT_DIR`），已废弃；
 * 升级时由 `config.ts` 的 `migrateLegacyGlobalInstance()` 负责把属于本工作区的那份搬过来。
 *
 * 刻意**不**跟着工作区走的东西：连接锁（见 `gateway-lock.ts`）。
 * 锁按 appId 全局互斥是护栏，不是缺陷——飞书长连接是集群模式、不广播，
 * 同一个机器人的事件只会随机推给其中一条连接，两个工作区共用同一个 appId
 * 会互相抢连接、并让消息随机落到错误的工作区。
 * 所以多开的前提仍是「一个工作区一个机器人（各自的 appId）」。
 */

/** 工作区本地实例目录名（相对工作区根目录）：`<工作区>/.pi/feishu`。 */
export const WORKSPACE_INSTANCE_SUBPATH = join(".pi", "feishu");

/** 0.6.0 之前的全局实例目录，仅为「搬迁旧数据 / 打提示」保留。 */
export const LEGACY_GLOBAL_ROOT_DIR = join(homedir(), ".pi", "agent", "feishu");

/** 卡片回调端口区间：3001/3002 是历史上 Pi / DSH 的固定端口，实例一律从 3003 起派生。 */
const INSTANCE_PORT_BASE = 3003;
const INSTANCE_PORT_SPAN = 97;

/** 展开开头的 `~` / `~/`；其余原样交给 path.resolve 处理。 */
function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

/** 工作区本地实例目录：`<工作区>/.pi/feishu`（绝对路径）。 */
export function workspaceInstanceDir(cwd: string = process.cwd()): string {
  return join(resolve(cwd), WORKSPACE_INSTANCE_SUBPATH);
}

/** 显式指定的实例目录（环境变量 `FEISHU_DATA_DIR`）；未设或纯空白返回 `undefined`。 */
export function explicitInstanceDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.FEISHU_DATA_DIR?.trim();
  if (!raw) return undefined;
  return resolve(expandHome(raw));
}

/**
 * 实例数据目录：显式指定优先，否则跟着工作区走，**永远有值**。
 * 相对路径按传入的 cwd 解析；daemon 场景请保证 cwd 就是工作区根目录。
 */
export function resolveInstanceDir(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  return explicitInstanceDir(env) ?? workspaceInstanceDir(cwd);
}

/** Feishu 数据根目录（= 实例数据目录）。 */
export function resolveRootDir(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  return resolveInstanceDir(env, cwd);
}

/**
 * Harness（DSH）数据根目录：与 Pi 同住一份实例目录下的 `harness/`，
 * 这样同一工作区里两个 runtime 的文件一起跟着工作区走。
 */
export function resolveHarnessRoot(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  return join(resolveInstanceDir(env, cwd), "harness");
}

/**
 * 卡片回调默认端口：按「实例目录 + base」稳定派生到 3003-3099。
 * 同一工作区每次启动得到同一个端口（飞书后台的回调地址只需配一次），
 * 不同工作区互不相同；base 只是把 Pi(3001) / DSH(3002) 两份默认值岔开。
 * 派生在区间内存在理论碰撞，需要精确控制时用 `FEISHU_CARD_ACTION_WEBHOOK_PORT`
 * 显式指定（显式值优先级更高）。
 */
export function instanceWebhookPort(base: number, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): number {
  const dir = resolveInstanceDir(env, cwd);
  const digest = createHash("sha1").update(`${dir}:${base}`).digest();
  return INSTANCE_PORT_BASE + (digest.readUInt16BE(0) % INSTANCE_PORT_SPAN);
}

/** 目录比较用的归一化：先展开 `~` 再取 realpath（软链、`/tmp` vs `/private/tmp` 视为同一处）；
 * 目录不存在时退回字面 resolve，保证纯函数在任何环境下都给出确定结果。 */
export function normalizeDir(dir: string): string {
  const expanded = resolve(expandHome(dir));
  try {
    return realpathSync(expanded);
  } catch {
    return expanded;
  }
}

/** 两个路径是否属于同一个工作区：相等，或一个是另一个的父目录（允许在子目录里启动 pi）。 */
export function sameWorkspace(a: string, b: string): boolean {
  const na = normalizeDir(a);
  const nb = normalizeDir(b);
  if (na === nb) return true;
  const inside = (parent: string, child: string) => {
    const rel = relative(parent, child);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  return inside(na, nb) || inside(nb, na);
}

/**
 * 是否「这份机器人属于别的工作区」——自动启动前的保险。
 *
 * 三条件同时成立才算：
 * 1. 没设 `FEISHU_ALLOW_FOREIGN_WORKSPACE=1`；
 * 2. 能拿到 owner 的 cwd（连接锁当前 owner，或属主工作区记录 owner-workspace.json）；
 * 3. owner 的 cwd 与本进程 cwd 不属于同一个工作区。
 *
 * 含义：这份配置对应的机器人**正在被另一个工作区使用**。飞书长连接是集群模式、不广播，
 * 两个工作区共用同一个 appId 会互相抢连接，并让消息随机落到错的工作区，
 * 因此调用方应拒绝自动启动，改为提示用户配一个自己的自建应用。
 *
 * 判据有两个来源，任一指向别的工作区就算外来：
 * 1. 连接锁当前 owner 的 cwd（锁被持时有效）；
 * 2. 属主工作区记录（`owner-workspace.json`）——锁空闲时靠它才能分辨归属。
 *
 * 确需在本目录临时接管时，设 `FEISHU_ALLOW_FOREIGN_WORKSPACE=1` 显式放行，
 * 或在本目录手动 `/feishu restart`（手动命令不受本保护限制，并会更新属主记录）。
 */
export function isForeignWorkspace(
  ownerCwd: string | undefined | null,
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  recordedOwnerCwd?: string | null,
): boolean {
  if (env.FEISHU_ALLOW_FOREIGN_WORKSPACE === "1") return false;
  const owners = [ownerCwd, recordedOwnerCwd].filter((value): value is string => Boolean(value?.trim()));
  if (owners.length === 0) return false;
  return owners.some((owner) => !sameWorkspace(owner, cwd));
}

/** 属主工作区记录文件名（放在实例根目录下）：标明这份实例属于哪个工作区。 */
export const OWNER_WORKSPACE_FILE = "owner-workspace.json";

/** 属主工作区记录文件的完整路径。 */
export function ownerWorkspacePath(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  return join(resolveRootDir(env, cwd), OWNER_WORKSPACE_FILE);
}

/** 读任意一份属主记录文件（缺文件 / 格式不对 / 字段为空都返回 `undefined`，不抛错）。 */
export function readOwnerWorkspaceAt(file: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { cwd?: unknown };
    return typeof parsed.cwd === "string" && parsed.cwd.trim() ? parsed.cwd : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 读当前实例的属主工作区记录。
 * 这份记录是「外来工作区保护」在锁空闲时的唯一判据：连接锁只记录了*当前*持有者，
 * 而记录记的是这份配置**长期属于谁**。
 */
export function readOwnerWorkspace(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string | undefined {
  return readOwnerWorkspaceAt(ownerWorkspacePath(env, cwd));
}

/** 把当前目录认领为属主工作区（连接成功后调用；写失败只意味着少了这道保险，不影响主流程）。 */
export function writeOwnerWorkspace(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): void {
  try {
    const file = ownerWorkspacePath(env, cwd);
    mkdirSync(dirname(file), { recursive: true });
    const payload = { cwd: normalizeDir(cwd), updatedAt: new Date().toISOString() };
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch {
    // 忽略：记录写不进去也不该阻断连接
  }
}
