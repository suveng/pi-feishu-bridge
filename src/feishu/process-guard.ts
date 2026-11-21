/**
 * 进程级「作用域隔离」：同一份插件在全局 `~/.pi/agent/npm` 与工作区 `.pi/npm` 各装一份时，
 * 一个 Pi 进程会按两个解析路径各加载一次，得到**两个互不相认的模块实例**（两套闭包、
 * 两份 autoStart、两套定时器）。2026-11-21 事故就是它们互相把对方写的网关锁判成 busy，
 * autoStart 拉起一个死一个，锁永远停在 `starting`，飞书侧一直断线。
 *
 * 结论不是「让用户只保留一份」，而是**两份都隔离好、各安其位**：
 * 1. 工作区（项目级）副本优先 —— 它更贴近当前工作区，版本也更可控；
 * 2. 全局副本在工作区内自动让位（不初始化、不抢锁、不 spawn），只在没有工作区副本时兜底；
 * 3. 同作用域内重复加载先到先得，后到者静默不初始化；
 * 4. 让位判据是**磁盘上的声明与版本**，与加载顺序无关（Pi 是先全局后工作区，先后不固定）。
 *
 * 判定结果只用于本进程是否初始化，不改变任何用户配置：两份都可以留着。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const PACKAGE_NAME = "@suwenguang/pi-feishu-bridge";

/** 进程级占位（`Symbol.for` 的键在同一 isolate 里跨模块实例共享）。 */
export const PROCESS_SLOT_KEY = Symbol.for("@suwenguang/pi-feishu-bridge.process-slot");

export type ExtensionScope = "workspace" | "global";

type Slot = { entry: string; scope: ExtensionScope; at: string };

export type LeaderElection =
  | { leader: true; scope: ExtensionScope; reason: "workspace-copy" | "global-only" | "workspace-copy-outdated" }
  | {
      leader: false;
      scope: ExtensionScope;
      reason: "workspace-copy-preferred" | "already-initialized";
      /** 本进程实际生效的那份入口（诊断用） */
      activeEntry: string;
    };

export type ElectionOptions = {
  /** 判定用的工作区目录，默认 `process.cwd()` */
  cwd?: string;
  now?: Date;
  /** 测试注入：工作区是否声明并装有本插件（默认读磁盘） */
  isWorkspaceCopyActive?: (cwd: string) => boolean;
  /** 测试注入：读取某个入口对应的插件版本（默认读 package.json） */
  readVersion?: (entry: string) => string | undefined;
};

/**
 * 从扩展入口路径判断这份副本属于哪个作用域。
 * 工作区副本的入口一定落在 `<cwd>/.pi/` 下（`.pi/npm/node_modules/...`）。
 */
export function resolveExtensionScope(entry: string, cwd: string = process.cwd()): ExtensionScope {
  const normalizedEntry = entry.replace(/\\/g, "/");
  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalizedCwd) return "global";
  return normalizedEntry.startsWith(`${normalizedCwd}/.pi/`) ? "workspace" : "global";
}

/** 工作区副本的出口路径（`.pi/npm` 安装位置的固定结构）。 */
export function workspaceCopyEntry(cwd: string = process.cwd()): string {
  return `${cwd.replace(/\/+$/, "")}/.pi/npm/node_modules/${PACKAGE_NAME}/.pi/extensions/feishu/index.ts`;
}

/** 从入口路径反推插件根目录（入口在 `<pkg>/.pi/extensions/feishu/index.ts`）。 */
export function packageRootOfEntry(entry: string): string {
  return resolve(dirname(entry), "../../..");
}

/** 读某个副本的版本号；读不到返回 undefined（当作「无法比较」处理）。 */
export function readCopyVersion(entry: string): string | undefined {
  try {
    const raw = readFileSync(resolve(packageRootOfEntry(entry), "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 工作区是否真的会加载自己的副本：`<cwd>/.pi/settings.json` 声明了本插件**且**入口文件存在。
 * 只声明不装、或装了不声明，都不算 —— 否则会让全局副本白让位，最后谁都不跑。
 */
export function isWorkspaceCopyActive(cwd: string = process.cwd()): boolean {
  const settingsPath = `${cwd.replace(/\/+$/, "")}/.pi/settings.json`;
  try {
    const raw = readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as { packages?: unknown };
    const packages = Array.isArray(parsed.packages) ? parsed.packages : [];
    const declared = packages.some((item) => typeof item === "string" && item.includes(PACKAGE_NAME));
    return declared && existsSync(workspaceCopyEntry(cwd));
  } catch {
    return false;
  }
}

/** 语义化版本比较：返回负数/0/正数；解析不了的版本按 0 处理。 */
function compareVersions(left: string | undefined, right: string | undefined): number {
  const parse = (value: string | undefined): number[] =>
    String(value ?? "0")
      .split("-")[0]
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 选出本进程唯一要初始化的一份。
 *
 * - 工作区副本：声明存在即生效（同作用域重复加载则先到先得）；
 * - 全局副本：只有当工作区副本**不存在**，或工作区副本版本更旧时才生效，
 *   避免工作区里躺着旧的 0.6.x 把新版顶掉。
 */
export function electExtensionLeader(entry: string, options: ElectionOptions = {}): LeaderElection {
  const cwd = options.cwd ?? process.cwd();
  const scope = resolveExtensionScope(entry, cwd);
  const at = (options.now ?? new Date()).toISOString();
  const slotStore = globalThis as unknown as Record<symbol, unknown>;
  const existing = slotStore[PROCESS_SLOT_KEY] as Slot | undefined;

  let workspaceCopyOutdated = false;
  if (scope === "global") {
    const activeCheck = options.isWorkspaceCopyActive ?? isWorkspaceCopyActive;
    if (activeCheck(cwd)) {
      const readVersion = options.readVersion ?? readCopyVersion;
      const workspaceVersion = readVersion(workspaceCopyEntry(cwd));
      const globalVersion = readVersion(entry);
      if (compareVersions(workspaceVersion, globalVersion) >= 0) {
        return {
          leader: false,
          scope,
          reason: "workspace-copy-preferred",
          activeEntry: workspaceCopyEntry(cwd),
        };
      }
      // 工作区副本比全局旧：全局兜底生效，避免在工作区里跑老代码。
      workspaceCopyOutdated = true;
    }
  }

  if (existing && existing.entry !== entry) {
    return { leader: false, scope, reason: "already-initialized", activeEntry: existing.entry };
  }

  slotStore[PROCESS_SLOT_KEY] = { entry, scope, at } satisfies Slot;
  if (scope === "workspace") return { leader: true, scope, reason: "workspace-copy" };
  return { leader: true, scope, reason: workspaceCopyOutdated ? "workspace-copy-outdated" : "global-only" };
}

/** 仅测试用：清掉进程级占位，避免用例之间互相污染（生产代码不要调用）。 */
export function releaseProcessSlotForTest(): void {
  delete (globalThis as unknown as Record<symbol, unknown>)[PROCESS_SLOT_KEY];
}
