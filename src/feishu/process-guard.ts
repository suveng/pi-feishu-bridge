/**
 * 进程级闸门：同一个 Pi 进程里只允许一份飞书桥接扩展生效。
 *
 * 为什么需要（2026-11-21 事故）：
 * 同一份插件可能在机器上存在**两份不同路径的副本** —— 全局 `~/.pi/agent/npm/@suwenguang/pi-feishu-bridge`
 * 与工作区 `<repo>/.pi/npm/@suwenguang/pi-feishu-bridge`。当 `~/.pi/agent/settings.json` 与
 * `<repo>/.pi/settings.json` 都注册了 `npm:@suwenguang/pi-feishu-bridge` 时，Pi 会按两个不同的
 * 解析路径各加载一次，得到**两个互不相认的模块实例**（两套闭包、两份 autoStart、两套定时器）。
 *
 * 表现与后果：
 * 1. 两个实例各 spawn 一个 daemon（同机出现两条 `tail -f /dev/null | exec pi`）；
 * 2. daemon 里第一个实例拿到网关锁（`owner.pid === process.pid`），第二个实例再抢同一把锁
 *    被判定 busy，`start()` 返回 `owned`，daemon 启动分支据此 `process.exit(0)`；
 * 3. 于是 autoStart 拉起一个死一个，锁永远停在 `starting`，飞书侧一直是断的。
 *
 * 修法：用 `globalThis` 上的 `Symbol.for(...)` 做进程级占位。`Symbol.for` 的键在同一个
 * isolate 里跨模块实例共享，因此**先加载的那份**拿到权限，后加载的那份直接跳过（不再注册工具、
 * 不再 spawn daemon、不再抢锁）。这只是兜底：插件仍应只在一处注册。
 */
export const PROCESS_SLOT_KEY = Symbol.for("@suwenguang/pi-feishu-bridge.process-slot");

export type ProcessSlotInfo = {
  /** 第一份副本拿位的时间（ISO 字符串） */
  at: string;
  /** 第一份副本的扩展入口路径 */
  entry: string;
};

export type ProcessSlotClaim =
  | { status: "claimed" }
  | { status: "duplicate"; previous: ProcessSlotInfo };

/**
 * 尝试占用本进程的桥接插槽。
 *
 * @param extensionEntry 本次加载的扩展入口路径（只用于诊断信息，不参与判定）
 * @param now 当前时间（测试注入用）
 */
export function claimProcessSlot(extensionEntry: string, now: Date = new Date()): ProcessSlotClaim {
  const scope = globalThis as unknown as Record<symbol, unknown>;
  const existing = scope[PROCESS_SLOT_KEY] as ProcessSlotInfo | undefined;
  if (existing && typeof existing.entry === "string") {
    return { status: "duplicate", previous: existing };
  }
  scope[PROCESS_SLOT_KEY] = { at: now.toISOString(), entry: extensionEntry } satisfies ProcessSlotInfo;
  return { status: "claimed" };
}

/** 仅测试用：清掉进程级占位，避免用例之间互相污染（生产代码不要调用）。 */
export function releaseProcessSlotForTest(): void {
  delete (globalThis as unknown as Record<symbol, unknown>)[PROCESS_SLOT_KEY];
}
