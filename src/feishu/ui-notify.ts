/**
 * 扩展 UI 输出回传（跨扩展事件契约）。
 *
 * 背景：Pi 侧扩展（例如 knowledge-flow 的 /req、/kb、/test）把结果写进
 * `ctx.ui.notify`。飞书场景下桥接跑在 `pi --mode rpc` 的 daemon 里，
 * notify 只会变成 daemon stdout 上的一行 JSON，飞书用户看不到任何内容。
 *
 * 约定：这类扩展在 notify 的同时额外 emit 本事件，桥接负责把文本回传到
 * 「发起该轮次的飞书会话」。
 *
 * 注意：事件名与载荷是跨包契约（`.pi/extensions/**` 与本包之间的约定），
 * 修改这里必须同步修改调用方。
 */
export const FEISHU_UI_NOTIFY_EVENT = "feishu:ui:notify";

/**
 * 进程级 sink 的 key。
 *
 * 为什么不能只用事件总线：桥接会为**每个飞书会话**单独建一个
 * DefaultResourceLoader（见 PiConversationRuntime.createSession），
 * 会话内的扩展实例与 daemon 主会话走的是**不同的** pi.events 总线。
 * 而扩展的 notify 恰好发生在会话内的扩展实例上，跨会话只能靠进程级全局对象。
 *
 * 用 Symbol.for 而不是字符串：同一个 key 字符串在全进程（含模块重复加载）
 * 得到同一个 Symbol，调用方无需 import 本文件。
 */
export const FEISHU_UI_NOTIFY_SINK = Symbol.for("pi.feishu.uiNotifySink");

/** 注册进程级输出回传 sink（桥接启动时调用，后注册者覆盖） */
export function setFeishuUiNotifySink(sink: (payload: FeishuUiNotifyPayload) => void) {
  (globalThis as Record<symbol, unknown>)[FEISHU_UI_NOTIFY_SINK] = sink;
}

/** 读取进程级输出回传 sink；未安装桥接时返回 undefined */
export function getFeishuUiNotifySink(): ((payload: FeishuUiNotifyPayload) => void) | undefined {
  const sink = (globalThis as Record<symbol, unknown>)[FEISHU_UI_NOTIFY_SINK];
  return typeof sink === "function" ? (sink as (payload: FeishuUiNotifyPayload) => void) : undefined;
}

/** 事件载荷：text 必填；level 对齐 ctx.ui.notify 的第二个参数 */
export type FeishuUiNotifyPayload = {
  text?: string;
  level?: "info" | "warning" | "error" | string;
};
