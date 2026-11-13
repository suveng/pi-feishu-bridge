/**
 * daemon 启动形状的**唯一来源**。
 *
 * 抽出来的原因：`/restart` 要在不加载 Pi SDK 的独立 worker 里复刻完全相同的启动参数。
 * 只要两边形状不一致，`looksLikeFeishuDaemon()`（认紧跟在 `-e` 后面的扩展入口）就认不出
 * 新进程是 daemon，残留进程回收会把重启后的实例当野进程留着或反复重建。
 */
import { DAEMON_LOG_PATH } from "./config.ts";

export type DaemonSpec = {
  extensionPath: string;
  piBin: string;
  args: string[];
};

/** POSIX 单引号转义：`it's` → `'it'\''s'` */
export function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function daemonSpec(extensionPath: string): DaemonSpec {
  const piBin = process.env.PI_BIN || "pi";
  // 2026-11-13 用户口径：「飞书进程应该与 pi 的 TUI 等同」。
  // 以前这里是 rpc + 六个 --no-*（关扩展 / 技能 / 提示模板 / 主题 / 上下文文件 / 内置工具），
  // 结果桥接侧与 TUI 能力面不一致：拿不到 skills、AGENTS.md 注入变少、内置工具也少。
  // 现在只保留 rpc 协议本身与显式 -e（显式入口不依赖扩展自动发现，settings 写坏也起得来）。
  const args = [
    "--mode", "rpc",
    "-e", extensionPath,
  ];
  return { extensionPath, piBin, args };
}

export function daemonCommand(spec: DaemonSpec): string {
  return `tail -f /dev/null | exec ${quoteShell(spec.piBin)} ${spec.args.map(quoteShell).join(" ")}`;
}

/** daemon 的 stdout/stderr 落点；worker 与 `startDaemon` 共用，便于一次 tail 看全流程 */
export function daemonLogPath(): string {
  return DAEMON_LOG_PATH;
}
