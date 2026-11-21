/**
 * 扫码注册飞书/Lark 机器人应用。
 * 二维码打印到终端；提示信息通过 onNotify 回调交给调用方（Pi 用 TUI 通知）。
 */
import qrcode from "qrcode-terminal";
import type { Domain } from "./types.ts";

export type RegisteredFeishuApp = {
  appId: string;
  appSecret: string;
  domain: Domain;
};

/**
 * 扫码创建应用时增量申请的权限（在平台默认模板上叠加，确认页会展示差异让扫码人同意）。
 *
 * - `application:app_slash_command:write`：斜杠指令面板注册，缺了 `/config`、`/sched` 等指令
 *   只会以普通消息形式送达，面板里看不到。
 * - `im:message.group_msg`：获取群组中所有消息（**敏感权限**，需要管理员在确认页点同意）。
 *   缺了它，飞书只会推送「@机器人」的群消息，`groupPolicy: open` / `groupKeywords` 都形同虚设 ——
 *   非 @ 消息压根不会到达桥接（2026-11-21 实测：日志里 30 多条群消息全部带 @，无一条例外）。
 */
export const REGISTER_APP_TENANT_SCOPES: string[] = [
  "application:app_slash_command:write",
  "im:message.group_msg",
];

type RegisterResult = {
  client_id: string;
  client_secret: string;
  user_info?: { tenant_brand?: string };
};

/** 一次扫码流程；addons 为空时走平台默认模板 */
async function runRegister(options: {
  notify: (text: string) => void;
  tenantScopes?: string[];
}): Promise<RegisterResult> {
  const lark = await import("@larksuiteoapi/node-sdk");
  const { notify, tenantScopes } = options;
  notify("正在准备飞书授权二维码... / Preparing Feishu authorization QR code...");

  return (await lark.registerApp({
    source: "pi-feishu-extension",
    // 增量申请权限：扫码确认页会在此基础上叠加，平台基础权限不受影响。
    // 若平台未开放额外配置灰度，该参数会被忽略并回退到默认流程。
    addons: tenantScopes?.length ? { scopes: { tenant: tenantScopes } } : undefined,
    onQRCodeReady(info: { url: string; expireIn: number }) {
      qrcode.generate(info.url, { small: true }, (qr) => {
        console.log("\n飞书/Lark 授权二维码 / Feishu/Lark authorization QR code");
        console.log(qr);
        console.log(info.url);
        console.log(`二维码 ${info.expireIn} 秒后过期 / QR code expires in ${info.expireIn} seconds.`);
      });
      notify("请在终端扫描二维码，或打开终端中显示的链接。 / Scan the QR code in terminal, or open the link printed there.");
    },
    onStatusChange(info: any) {
      if (info?.status === "domain_switched") {
        notify("检测到 Lark 租户，正在切换区域。 / Detected Lark tenant; switching domain.");
      }
    },
  })) as RegisterResult;
}

export async function registerFeishuApp(options?: { onNotify?: (text: string) => void }): Promise<RegisteredFeishuApp> {
  const notify = options?.onNotify ?? ((text: string) => console.log(text));

  let result: RegisterResult;
  try {
    result = await runRegister({ notify, tenantScopes: REGISTER_APP_TENANT_SCOPES });
  } catch (error) {
    // 增量权限被租户拒绝（敏感权限未审批 / 平台未开放 addons）时，退回默认模板重来一次，
    // 而不是整个登记流程直接失败 —— 否则用户连应用都创建不出来。
    const reason = error instanceof Error ? error.message : String(error);
    notify(
      `增量申请权限未通过（${reason}）。正在改用平台默认权限重新创建，可在开发者后台手动补开「获取群组中所有消息」。 / Addon scopes rejected; retrying with default scopes.`,
    );
    result = await runRegister({ notify });
  }

  const domain: Domain = result?.user_info?.tenant_brand === "lark" ? "lark" : "feishu";
  return {
    appId: result.client_id,
    appSecret: result.client_secret,
    domain,
  };
}
