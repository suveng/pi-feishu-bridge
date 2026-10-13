import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, ensureRoot, mask, resolveConfigWriteTarget, writeJson } from "../../feishu/config.ts";
import { registerFeishuApp } from "../../feishu/app-register.ts";
import type { Domain, FeishuConfig, GroupPolicy } from "../../feishu/types.ts";

export async function uiSelect<T extends string>(ctx: ExtensionCommandContext, title: string, options: Array<{ value: T; label: string }>, initialValue?: T): Promise<T> {
  const ui: any = ctx.ui;
  if (typeof ui.select !== "function") {
    throw new Error("Current UI does not support select prompts.");
  }
  const labels = options.map((o) => o.label);
  const initialLabel = options.find((o) => o.value === initialValue)?.label;
  const selectedLabel = await ui.select(title, labels, initialLabel ? { initialValue: initialLabel } : undefined);
  const matched = options.find((o) => o.label === selectedLabel);
  if (!matched) {
    throw new Error("Selection cancelled.");
  }
  return matched.value;
}

export async function uiInput(ctx: ExtensionCommandContext, title: string, defaultValue = ""): Promise<string> {
  const ui: any = ctx.ui;
  if (typeof ui.input === "function") return String(await ui.input(title, defaultValue) || "");
  if (typeof ui.prompt === "function") return String(await ui.prompt(title, defaultValue) || "");
  throw new Error("Current UI does not support input prompts.");
}

export async function uiConfirm(ctx: ExtensionCommandContext, title: string, initial = true): Promise<boolean> {
  const ui: any = ctx.ui;
  if (typeof ui.confirm === "function") return Boolean(await ui.confirm(title, "", { initialValue: initial }));
  return initial;
}

export async function runSetup(ctx: ExtensionCommandContext) {
  ensureRoot();
  const mode = await uiSelect(ctx,
    "配置方式 / Setup method",
    [
      { value: "auto", label: "扫码自动创建飞书助手 / Create by QR code" },
      { value: "manual", label: "手动填写已有应用 / Configure existing app" },
    ],
    "auto",
  );

  let appId = "";
  let appSecret = "";
  let domain: Domain = "feishu";

  if (mode === "auto") {
    const created = await registerFeishuApp({
      onNotify: (text) => ctx.ui.notify(text, "info"),
    });
    appId = created.appId;
    appSecret = created.appSecret;
    domain = created.domain;
  } else {
    domain = await uiSelect(ctx,
      "应用区域 / App region",
      [
        { value: "feishu", label: "Feishu 中国 / Feishu China" },
        { value: "lark", label: "Lark 国际 / Lark Global" },
      ],
      "feishu",
    );
    appId = (await uiInput(ctx, "App ID / 应用 ID")).trim();
    appSecret = (await uiInput(ctx, "App Secret / 应用密钥")).trim();
  }

  const groupPolicy = await uiSelect<GroupPolicy>(ctx,
    "群聊策略 / Group policy",
    [
      { value: "open", label: "open：不需要 @，群/话题消息自动回复 / auto reply without @ in groups/topics" },
      { value: "mention", label: "mention：只有 @ 机器人才回复 / reply only when mentioned" },
    ],
    "open",
  );

  const config: FeishuConfig = {
    appId,
    appSecret,
    domain,
    groupPolicy,
    language: "zh",
    reactEmoji: DEFAULT_CONFIG.reactEmoji,
    autoStart: true,
  };
  // 本目录若不是这份全局实例的属主工作区（典型：在别的目录扫码建应用），
  // 凭证写进本目录实例目录，不覆盖全局配置，并提示用启动器打开。
  const target = resolveConfigWriteTarget();
  writeJson(target.path, config);

  ctx.ui.notify(
    target.redirectedDir
      ? `飞书配置已保存到本目录实例 / Feishu config saved to this directory's instance\nPath: ${target.path}\nApp ID: ${mask(appId)}\n群聊策略 / Group policy: ${groupPolicy}\n\n本目录不是这份全局实例的所属工作区，凭证已写入本目录实例目录，未覆盖全局配置。\n请用 ./.pi/pi-feishu.sh 启动本工作区（或先 export FEISHU_DATA_DIR="${target.redirectedDir}"）。`
      : `飞书配置已保存 / Feishu config saved\nPath: ${target.path}\nApp ID: ${mask(appId)}\n群聊策略 / Group policy: ${groupPolicy}`,
    "info",
  );

  if (await uiConfirm(ctx, "现在启动飞书连接？ / Start Feishu now?", true)) {
    return config;
  }
  return undefined;
}
