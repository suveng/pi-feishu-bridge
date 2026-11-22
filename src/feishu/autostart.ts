/**
 * macOS 系统级开机自启：LaunchAgent（登录即起）+ 常驻巡检 supervisor。
 *
 * 与 `config.pi.json` 里的 `autoStart` 区别：
 * - `autoStart` 只管「Pi 进程启动时要不要自动拉起 daemon」，前提是有人先开 Pi；
 * - 本模块管「用户登录 macOS 后不打开任何 Pi，daemon 也要自己起来」，由 launchd 负责。
 *
 * 2026-11-22 与用户确认的三条口径：
 * 1. 开关只在 Pi TUI（`/feishu autostart on|off`）—— 桥接没起来时飞书里也切不了，避免死锁；
 * 2. 关闭自启动 = 取消下次开机启动，**当前 daemon 继续跑**（否则要回到电脑前才能恢复）；
 * 3. 按工作区登记：在哪个工作区执行 on 就管哪个，可累计多个，off 只移除当前工作区。
 *
 * 为什么不是「一个工作区一个 plist」：注册表 + 单个 supervisor 更好维护 ——
 * 加工作区只改 JSON，不反复 bootstrap；supervisor 一轮巡检天然覆盖所有登记项。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const AUTOSTART_LABEL = "com.suveng.pi-feishu.autostart";
/** 注册表放机器级位置：一个用户一份，记录哪些工作区要开机自启。 */
export const AUTOSTART_REGISTRY_PATH = join(homedir(), ".pi", "agent", "feishu-autostart.json");
export const AUTOSTART_LOG_PATH = join(homedir(), ".pi", "agent", "feishu-autostart.log");
export const AUTOSTART_PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`);

export type AutostartEntry = {
  /** 工作区根目录（daemon 的 cwd，也是实例目录的父目录） */
  workspace: string;
  /** 登记时正在使用的扩展入口（daemon 用它 -e 重新加载） */
  extensionPath: string;
  /** pi 可执行文件（稳定 launcher，例如 ~/.pi/agent/bin/pi） */
  piBin: string;
  /** 登记时 supervisor 用的 node（仅作记录；实际由 autostart-launch.sh 现找） */
  nodeBin: string;
  addedAt: string;
  updatedAt: string;
};

export type AutostartRegistry = {
  version: 1;
  /** key = 工作区绝对路径 */
  entries: Record<string, AutostartEntry>;
};

const EMPTY_REGISTRY: AutostartRegistry = { version: 1, entries: {} };

/**
 * 读注册表。文件缺失 / JSON 坏 / 结构不对都回落到空表：
 * 开机自启属于「锦上添花」，坏文件不能让 Pi 启动或命令报错。
 */
export function readAutostartRegistry(path: string = AUTOSTART_REGISTRY_PATH): AutostartRegistry {
  if (!existsSync(path)) return { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AutostartRegistry>;
    const entries: Record<string, AutostartEntry> = {};
    for (const [key, value] of Object.entries(parsed?.entries ?? {})) {
      const entry = normalizeEntry(value);
      if (entry) entries[resolve(key)] = entry;
    }
    return { version: 1, entries };
  } catch {
    return { version: 1, entries: {} };
  }
}

function normalizeEntry(raw: unknown): AutostartEntry | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const workspace = typeof value.workspace === "string" ? value.workspace.trim() : "";
  const extensionPath = typeof value.extensionPath === "string" ? value.extensionPath.trim() : "";
  const piBin = typeof value.piBin === "string" ? value.piBin.trim() : "";
  if (!workspace || !extensionPath || !piBin) return undefined;
  return {
    workspace: resolve(workspace),
    extensionPath,
    piBin,
    nodeBin: typeof value.nodeBin === "string" ? value.nodeBin : "",
    addedAt: typeof value.addedAt === "string" ? value.addedAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
  };
}

export function writeAutostartRegistry(registry: AutostartRegistry, path: string = AUTOSTART_REGISTRY_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

export function upsertAutostartEntry(
  entry: Omit<AutostartEntry, "addedAt" | "updatedAt">,
  path: string = AUTOSTART_REGISTRY_PATH,
): { registry: AutostartRegistry; added: boolean } {
  const registry = readAutostartRegistry(path);
  const key = resolve(entry.workspace);
  const existing = registry.entries[key];
  const now = new Date().toISOString();
  registry.entries[key] = {
    ...entry,
    workspace: key,
    addedAt: existing?.addedAt ?? now,
    updatedAt: now,
  };
  writeAutostartRegistry(registry, path);
  return { registry, added: !existing };
}

/** 只移除指定工作区；返回移除后是否还有别的登记项（决定要不要卸 LaunchAgent）。 */
export function removeAutostartEntry(
  workspace: string,
  path: string = AUTOSTART_REGISTRY_PATH,
): { registry: AutostartRegistry; removed: boolean } {
  const registry = readAutostartRegistry(path);
  const key = resolve(workspace);
  const removed = Boolean(registry.entries[key]);
  if (removed) {
    delete registry.entries[key];
    writeAutostartRegistry(registry, path);
  }
  return { registry, removed };
}

/** XML 文本转义（plist 里路径可能含 `&`、`<`、引号）。 */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type LaunchAgentSpec = {
  /** 包内 `scripts/autostart-launch.sh` 的绝对路径（负责现找 node 再 exec supervisor） */
  launcherPath: string;
  label?: string;
  logPath?: string;
  workingDirectory?: string;
  /** 只作为 plist 的基础 PATH；真正的 node 由 launcher 现找 */
  pathHint?: string;
};

/**
 * 生成 LaunchAgent plist。
 *
 * 关键配置的理由：
 * - `RunAtLoad`：登录（launchd 用户域加载）立刻跑一次，不等下一轮定时；
 * - `KeepAlive.SuccessfulExit=false`：supervisor 崩溃才重启；它以 0 退出（注册表空了）时**不再拉起**，
 *   否则关掉自启会变成无限重启循环；
 * - `ThrottleInterval=30`：崩溃后至少隔 30s 再试，避免 node 找不到时刷日志；
 * - 不写死 node 绝对路径：`ProgramArguments` 是 `/bin/sh <launcher>`，
 *   node 升级（fnm/brew）后旧路径会失效，写死就等于开机静默失败。
 */
export function renderLaunchAgentPlist(spec: LaunchAgentSpec): string {
  const label = spec.label ?? AUTOSTART_LABEL;
  const logPath = spec.logPath ?? AUTOSTART_LOG_PATH;
  const workingDirectory = spec.workingDirectory ?? homedir();
  const pathHint = spec.pathHint
    ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${xmlEscape(spec.launcherPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(workingDirectory)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(pathHint)}</string>
  </dict>
</dict>
</plist>
`;
}

export function writeLaunchAgentPlist(spec: LaunchAgentSpec, plistPath: string = AUTOSTART_PLIST_PATH): string {
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, renderLaunchAgentPlist(spec), "utf8");
  return plistPath;
}

export type LaunchctlRunner = (args: string[]) => { ok: boolean; output: string };

/** 真实执行器：spawnSync /bin/launchctl。 */
function realLaunchctl(args: string[]): { ok: boolean; output: string } {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ok: result.status === 0, output };
}

let launchctlRunner: LaunchctlRunner = realLaunchctl;

/** 仅测试用：替换 launchctl 执行器，返回原执行器以便恢复（避免单测真去操作 LaunchAgent）。 */
export function setLaunchctlRunner(runner: LaunchctlRunner): LaunchctlRunner {
  const previous = launchctlRunner;
  launchctlRunner = runner;
  return previous;
}

function runLaunchctl(args: string[]): { ok: boolean; output: string } {
  return launchctlRunner(args);
}

function guiDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : Number(process.env.UID ?? 0);
  return `gui/${uid}`;
}

/** LaunchAgent 是否已在用户域加载（`launchctl print` 退出码 0 即已加载）。 */
export function launchAgentLoaded(label: string = AUTOSTART_LABEL): boolean {
  return runLaunchctl(["print", `${guiDomain()}/${label}`]).ok;
}

/**
 * 安装（或刷新）LaunchAgent。
 * 已加载时走 `kickstart -k`：重启 supervisor 让它重读注册表，不必 bootout/bootstrap 来回切。
 */
export function installLaunchAgent(
  spec: LaunchAgentSpec,
  plistPath: string = AUTOSTART_PLIST_PATH,
): { ok: boolean; error?: string; reloaded: boolean } {
  const label = spec.label ?? AUTOSTART_LABEL;
  writeLaunchAgentPlist(spec, plistPath);
  if (launchAgentLoaded(label)) {
    const kick = runLaunchctl(["kickstart", "-k", `${guiDomain()}/${label}`]);
    return kick.ok ? { ok: true, reloaded: true } : { ok: false, reloaded: true, error: kick.output };
  }
  const boot = runLaunchctl(["bootstrap", guiDomain(), plistPath]);
  if (boot.ok) return { ok: true, reloaded: false };
  // 竞态：print 看不到但 bootstrap 认为已存在 → 退一步重启它
  if (/already|exists|bootstrapped/i.test(boot.output)) {
    const kick = runLaunchctl(["kickstart", "-k", `${guiDomain()}/${label}`]);
    if (kick.ok) return { ok: true, reloaded: true };
  }
  return { ok: false, reloaded: false, error: boot.output || "launchctl bootstrap 失败" };
}

/** 卸载 LaunchAgent 并删除 plist。未加载时只删文件，不报错。 */
export function uninstallLaunchAgent(plistPath: string = AUTOSTART_PLIST_PATH, label: string = AUTOSTART_LABEL): { ok: boolean; error?: string } {
  const boot = runLaunchctl(["bootout", `${guiDomain()}/${label}`]);
  rmSync(plistPath, { force: true });
  // 未加载时 bootout 返回非 0，属正常（没有可卸的）；加载中才报错，此时 plist 也已删掉
  if (!boot.ok && launchAgentLoaded(label)) return { ok: false, error: boot.output };
  return { ok: true };
}

/**
 * 解析 pi 可执行文件：优先 `PI_BIN`，其次登录 shell 的 `command -v pi`，最后 pi 的托管 launcher。
 * daemon 的 `-e` 形态由 `scripts/autostart-supervisor.mjs` 复刻，这里只负责找到人。
 */
export function resolvePiBinary(): string | undefined {
  const explicit = process.env.PI_BIN?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  const found = spawnSync("/bin/sh", ["-lc", "command -v pi"], { encoding: "utf8" });
  const candidate = (found.stdout ?? "").trim().split("\n")[0];
  if (candidate && existsSync(candidate)) return candidate;
  const managed = join(homedir(), ".pi", "agent", "bin", "pi");
  return existsSync(managed) ? managed : undefined;
}

/** 当前进程的 node 真身（解开 fnm multishell 的临时链接），仅用于注册表记录与提示。 */
export function resolveNodeBinary(): string {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}
