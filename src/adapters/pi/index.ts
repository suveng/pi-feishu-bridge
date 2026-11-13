import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BRIDGE_PI_PATH, CHILD_SESSION_ENV, CONFIG_PI_PATH, DAEMON_LOG_PATH, DEBUG_PI_LOG_PATH, DEDUPE_PI_PATH, ensureRoot, loadConfig, mask, removePath, PI_SOURCE, setRuntimeSource, STATE_PI_PATH, writeJson } from "../../feishu/config.ts";
import { debugLog } from "../../feishu/debug.ts";
import { FEISHU_UI_NOTIFY_EVENT, setFeishuUiNotifySink, type FeishuUiNotifyPayload } from "../../feishu/ui-notify.ts";
import { FeishuBridgeRuntime } from "../../feishu/bridge-runtime.ts";
import { FeishuBridgeStore } from "../../feishu/bridge-store.ts";
import { FeishuDelivery } from "../../feishu/delivery.ts";
import { acquireGatewayLock, gatewayLockPath, readAllGatewayOwnerPids, readGatewayOwner, type GatewayLockHandle, type GatewayOwner } from "../../feishu/gateway-lock.ts";
import { isForeignWorkspace, readOwnerWorkspace, resolveInstanceDir, writeOwnerWorkspace } from "../../feishu/instance.ts";
import {
  DEFAULT_INSTANCE_NAME,
  instanceDirForName,
  instanceConfigPath,
  instanceNameFromDir,
  isValidInstanceName,
  listInstances,
  readInstanceConfig,
} from "../../feishu/instances.ts";
import { FeishuMessageHandler } from "../../feishu/message-handler.ts";
import { runSetup, uiConfirm } from "./setup.ts";
import {
  RUNTIME_CONFIG_KEYS,
  clearRuntimeOverrides,
  formatRuntimeConfig,
  getRuntimeOverrides,
  setRuntimeConfig,
} from "../../feishu/runtime-config.ts";
import { BotUnavailableError, FeishuTransport } from "../../feishu/transport.ts";
import { withBackoffRetry } from "../../feishu/retry.ts";
import type { FeishuConfig, FeishuStatus } from "../../feishu/types.ts";
import { createCardActionHandler } from "../../feishu/card-actions.ts";
import { LearnApprovalClient } from "../../feishu/learn-approval.ts";
import { resolveCardTarget } from "../../feishu/reply-card.ts";
import { installExitFlush } from "../../feishu/live-cards.ts";
import { daemonCommand, daemonSpec } from "../../feishu/daemon-spec.ts";
import { ackRestartIfPending, requestRestart, type RestartTrigger } from "../../feishu/restart.ts";
import { PiConversationRuntime, handlePiMessageEnd } from "./PiConversationRuntime.ts";

/**
 * Pi Runtime 适配器的扩展入口（薄 PI bootstrap）：
 * 只保留 Pi 相关的启动/命令/daemon/工具注册逻辑，
 * 其余飞书逻辑全部在 src/feishu 公共层。
 *
 * @param options.extensionPath 当前扩展入口文件路径（daemon 用 -e 重新加载它）。
 */
export default function createPiFeishuExtension(pi: ExtensionAPI, options?: { extensionPath?: string }) {
  const extensionEntry = options?.extensionPath || fileURLToPath(import.meta.url);
  // 启动重试的退避序列：4 次重试、累计约 15s。刻意压在网关锁 stale 阈值（30s）以内，
  // 这样重试期间不需要额外心跳也不会被别的实例抢走锁。
  const START_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
  // Pi 进程使用 Pi 自己的配置/状态/记录文件（默认即 Pi，显式声明便于维护）
  setRuntimeSource(PI_SOURCE);
  if (process.env[CHILD_SESSION_ENV] === "1") {
    return;
  }

  // 进程被 kill（重启桥接）时，把在册的「回复中」卡片翻成「已停止」并写明原因。
  // 少了这一步，飞书侧会永久停在「正在回复…」（2026-10-14 事故）。
  installExitFlush();

  // 模型可读写白名单配置（热更新 + 落盘）
  registerFeishuConfigTools(pi);

  // 注意：不要在这里调用 hideFeishuConfigTools(pi)。getActiveTools()/setActiveTools()
  // 是会话级 API，在扩展加载期（session_start 之前）调用会抛错，导致后续
  // /feishu 命令注册等逻辑全部不执行。隐藏逻辑统一放在 session_start 里。

  let transport: FeishuTransport | undefined;
  let gatewayLock: GatewayLockHandle | undefined;
  const bridgeStore = new FeishuBridgeStore();
  const delivery = new FeishuDelivery(() => transport);
  const bridge = new FeishuBridgeRuntime(bridgeStore, delivery);
  const initialConfig = loadConfig();
  const conversations = new PiConversationRuntime(process.cwd(), bridge, {
    promptNotifySec: initialConfig?.promptNotifySec,
    promptTimeoutSec: initialConfig?.promptTimeoutSec,
  });
  const messageHandler = new FeishuMessageHandler(conversations, () => transport, bridgeStore, {
    /**
     * 飞书里 `/restart`：换一份新代码继续跑，会话上下文不丢。
     *
     * 只在 daemon 里允许 —— TUI 里重启桥接是 `/feishu restart`，那条路径完全在进程内，
     * 走这里反而会把用户的交互式会话一起杀掉。
     */
    restart: async (request) => {
      const activeTransport = transport;
      if (!activeTransport) return { ok: false, error: "飞书连接未就绪，无法重启。" };
      if (process.env.PI_FEISHU_DAEMON !== "1") {
        return { ok: false, error: "当前 Pi 不是桥接 daemon。在 Pi 终端里请用 `/feishu restart`。" };
      }
      const trigger: RestartTrigger = request.trigger;
      const result = await requestRestart({
        transport: activeTransport,
        trigger,
        extensionPath: extensionEntry,
        cwd: process.cwd(),
        hasActiveRun: request.hasActiveRun,
        force: request.force,
      });
      if (!result.ok) return result;
      // 卡片已发出、worker 已在等我们死：留 1.2s 让消息落库，然后**发 SIGTERM 给自己**而不是
      // 直接 process.exit —— 只有信号路径会经过 installExitFlush()，把别的会话在跑的「回复中」
      // 卡片统一收尾；直接 exit 会让那些卡永久停在「正在回复…」（2026-10-14 事故同因）。
      // launcher 一起收，否则 `bash -lc 'tail -f /dev/null | exec pi …'` 的壳会残留。
      setTimeout(() => {
        terminateLauncherParent();
        process.kill(process.pid, "SIGTERM");
      }, 1200);
      return result;
    },
  });

  // 扩展 UI 输出回传：knowledge-flow 等 Pi 扩展的 ctx.ui.notify 走这里回到飞书会话。
  // 以进程级 sink 为准：每个飞书会话各自的 DefaultResourceLoader 有独立的 pi.events 总线，
  // 而 notify 发生在会话内的扩展实例上（详见 ui-notify.ts 的说明）。
  setFeishuUiNotifySink((payload) => conversations.pushUiNotify(payload));
  // 选择题卡片发送器：模型调 feishu_ask 时，把卡片发到该会话。
  // 走 resolveCardTarget：普通会话平铺（避免与回答卡归成同一个回复簇、把先到的卡挤掉），
  // 话题群/回复链必须 reply（create 会另开一个话题）。
  conversations.setAskSender(async (key, card) => {
    const activeTransport = transport;
    if (!activeTransport) throw new Error("飞书连接未启动");
    const route = bridgeStore.getRoute(key);
    if (!route) throw new Error("找不到该会话的路由");
    const target = resolveCardTarget(route);
    // 返回卡片消息 ID：超时后要拿它 patch 同一张卡
    if ("chatId" in target && target.chatId) return activeTransport.createCard(target.chatId, card);
    if (!route.lastMessageId) throw new Error("找不到该会话最近的消息");
    return activeTransport.replyCard(route.lastMessageId, card);
  });
  // 超时后把提问卡片原地刷成「已超时」，避免留一张还能点、点了没反应的僵尸卡
  conversations.setAskCardUpdater(async (messageId, card) => {
    const activeTransport = transport;
    if (!activeTransport) throw new Error("飞书连接未启动");
    await activeTransport.updateCard(messageId, card);
  });
  // 进化审批：把 /learn 的落地变成一道必须过的飞书审批。
  // 审批单的审批人、表单结构在飞书审批定义里；这里只负责拿配置与发起人。
  // 提交与查询拆开：提交只建单、立即返回实例号，绝不在一次工具调用里等审批人。
  const buildLearnApprovalClient = (): LearnApprovalClient => {
    const activeTransport = transport;
    if (!activeTransport) throw new Error("飞书连接未启动，无法发起审批");
    const approval = loadConfig()?.learnApproval;
    if (!approval) {
      throw new Error(
        "未配置进化审批：请在飞书审批后台建一个带「多行文本」控件的审批，"
        + `再把它的 approval_code 写进 ${CONFIG_PI_PATH} 的 learnApproval.approvalCode`,
      );
    }
    return new LearnApprovalClient({
      api: { request: (args) => activeTransport.requestApi(args) },
      config: approval,
      log: (event, data) => debugLog(event, (data ?? {}) as Record<string, unknown>),
    });
  };

  // 【提交】只建单：发起人取自该会话最近一条消息的发送者（审批单里要显示是谁要进化）
  conversations.setLearnApprovalSubmitter(async (key, body) => {
    const client = buildLearnApprovalClient();
    const senderOpenId = bridgeStore.getRoute(key)?.senderOpenId;
    if (!senderOpenId) throw new Error("拿不到该会话的发送人 open_id，无法发起审批");
    return client.create({ body, applicantOpenId: senderOpenId });
  });

  // 【查询】按实例号查一次状态：给「超时 / 被打断后用同一张单续查」用，不重发
  conversations.setLearnApprovalQuerier(async (_key, instanceCode) => {
    return buildLearnApprovalClient().query(instanceCode);
  });
  // 事件总线仅作为同总线场景（扩展与桥接在同一 loader 下）的补充
  try {
    (pi as any).events?.on?.(FEISHU_UI_NOTIFY_EVENT, (payload: FeishuUiNotifyPayload) => {
      conversations.pushUiNotify(payload);
    });
  } catch (error) {
    debugLog("feishu.ui.notify_bridge_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const STATUS_KEY = "feishu-connection";
  const STATUS_REFRESH_MS = 2_000;
  let uiRef: { setStatus?: (key: string, text: string | undefined) => void } | undefined;
  let lastStatusText: string | undefined;
  /** 裸开保护：本目录不是全局配置所属工作区时，记下 owner 的 cwd（用于状态栏与启动提示）。 */
  let foreignWorkspaceOwner: string | undefined;
  let statusRefreshTimer: NodeJS.Timeout | undefined;
  const buildTag = process.env.FEISHU_EXT_DEV === "1" ? " [DEV]" : "";

  function setStatusText(text: string | undefined) {
    if (lastStatusText === text) return;
    lastStatusText = text;
    uiRef?.setStatus?.(STATUS_KEY, text);
  }

  function updateStatus(status: FeishuStatus) {
    const cfg = loadConfig();
    const brand = cfg?.domain === "lark" ? "Lark" : "Feishu";
    setStatusText(statusText(brand, status));
  }

  function currentGatewayOwner() {
    return readGatewayOwner(loadConfig()?.appId);
  }
  
  function withBuildTag(text: string) {
    return `${text}${buildTag}`;
  }

  function statusText(brand: "Feishu" | "Lark", status: FeishuStatus) {
    const labels: Record<FeishuStatus, string> = {
      "not configured": "未配置 / Not configured",
      connecting: "连接中 / Connecting",
      connected: "已连接 / Connected",
      disconnected: "已断开 / Disconnected",
      owned: "连接被占用 / In use by another process",
      "bot unavailable": "机器人不可用 / Bot unavailable",
    };
    return withBuildTag(`${brand}: ${labels[status]}`);
  }

  /** 单实例一行状态：本进程连接优先，其次网关锁（= detached daemon 的心跳）。 */
  function instanceStateBrief(dir: string, cfg: ReturnType<typeof readInstanceConfig>) {
    if (!cfg) return { icon: "○", text: "未配置" };
    if (dir === currentInstanceDir() && transport?.isRunning()) return { icon: "●", text: "已连接(进程内)" };
    const owner = readGatewayOwner(cfg.appId);
    if (!owner) return { icon: "○", text: "未运行" };
    if (owner.status === "connected") return { icon: "●", text: `已连接(daemon ${owner.pid})` };
    if (owner.status === "starting") return { icon: "◐", text: `启动中(daemon ${owner.pid})` };
    return { icon: "◌", text: `${owner.status}(daemon ${owner.pid})` };
  }

  /** 多实例时状态栏改成一行概览；只有一个实例时返回 undefined（沿用单实例文案）。 */
  function multiInstanceStatusText() {
    const instances = listInstances(process.cwd()).filter((instance) => instance.configured);
    if (instances.length < 2) return undefined;
    const current = currentInstanceDir();
    const segments = instances.map((instance) => {
      const name = instanceNameFromDir(process.cwd(), instance.dir) || instance.name;
      const { icon, text } = instanceStateBrief(instance.dir, readInstanceConfig(instance.dir));
      return `${icon} ${name}${instance.dir === current ? "*" : ""} ${text}`;
    });
    const prefix = foreignWorkspaceOwner ? `(属 ${foreignWorkspaceOwner}) ` : "";
    return withBuildTag(`${prefix}Feishu: ${segments.join(" | ")}`);
  }

  function refreshStatusFromState() {
    const multi = multiInstanceStatusText();
    if (multi) {
      setStatusText(multi);
      return;
    }
    const cfg = loadConfig();
    const brand = cfg?.domain === "lark" ? "Lark" : "Feishu";
    if (!cfg) {
      setStatusText(statusText(brand, "not configured"));
      return;
    }
    // 裸开保护：不沿用锁 owner 的 connected（那是另一个工作区的连接），
    // 固定显示归属方，避免误判「本工作区已连上机器人」。
    if (foreignWorkspaceOwner) {
      setStatusText(`${brand}: 连接属于其他工作区 / Owned by ${foreignWorkspaceOwner}`);
      return;
    }
    if (transport?.isRunning()) {
      setStatusText(statusText(brand, "connected"));
      return;
    }
    const owner = currentGatewayOwner();
    if (owner?.status === "connected") {
      setStatusText(statusText(brand, "connected"));
    } else if (owner?.status === "starting") {
      setStatusText(statusText(brand, "connecting"));
    } else if (owner) {
      setStatusText(statusText(brand, "disconnected"));
    } else {
      setStatusText(statusText(brand, "disconnected"));
    }
  }

  function startStatusRefresh() {
    if (statusRefreshTimer) return;
    refreshStatusFromState();
    statusRefreshTimer = setInterval(refreshStatusFromState, STATUS_REFRESH_MS);
    statusRefreshTimer.unref?.();
  }

  function stopStatusRefresh() {
    if (!statusRefreshTimer) return;
    clearInterval(statusRefreshTimer);
    statusRefreshTimer = undefined;
  }

  function clearStatus() {
    stopStatusRefresh();
    lastStatusText = undefined;
    uiRef?.setStatus?.(STATUS_KEY, undefined);
  }

  pi.on("message_end", async (event, ctx) => {
    handlePiMessageEnd(bridge, ctx.sessionManager.getSessionId(), undefined, event.message);
  });

  async function start(config?: FeishuConfig, options: { takeover?: boolean } = {}) {
    if (transport?.isRunning()) {
      updateStatus("connected");
      return "already";
    }
    const cfg = config || loadConfig();
    if (!cfg) {
      updateStatus("not configured");
      throw new Error(`Missing config. Run /feishu setup first. 配置不存在，请先运行 /feishu setup。`);
    }
    updateStatus("connecting");
    const lockResult = await acquireGatewayLock(process.cwd(), Boolean(options.takeover), cfg.appId);
    if (lockResult.status === "busy") {
      updateStatus("owned");
      return { status: "owned" as const, owner: lockResult.owner };
    }
    // 拿锁成功 = 本目录正式成为这份实例的属主工作区（写进 owner-workspace.json）。
    // 这份记录让「裸开保护」在锁空闲时也能分辨归属：否则本工作区 daemon 一停，
    // 别的目录裸开就会把连接接过去（锁里没有 owner 可对比）。
    writeOwnerWorkspace(process.cwd());
    gatewayLock = lockResult.handle;
    gatewayLock.setOnLost(async () => {
      await transport?.stop();
      transport = undefined;
      gatewayLock = undefined;
      updateStatus(loadConfig() ? "owned" : "not configured");
      if (process.env.PI_FEISHU_DAEMON === "1") {
        terminateLauncherParent();
        process.exit(0);
      }
    });
    transport = new FeishuTransport(cfg, (msg) => messageHandler.handle(msg), createCardActionHandler(conversations, () => transport));
    const startedTransport = transport;
    try {
      // 启动期一次性初始化最容易撞上瞬时断连（ECONNRESET / socket hang up）：
      // 之前这里一次失败就 release 锁并 throw，daemon 随 process.exit(1) 消失、不重试。
      // 现在按 1s→2s→4s→8s 退避重试（累计约 15s，远小于 30s 的锁 stale 阈值），
      // 凭证类错误（403 / 999xxxxx）不是「可重试」，仍然立即失败退出。
      await withBackoffRetry(() => startedTransport.start(), {
        delaysMs: START_RETRY_DELAYS_MS,
        onRetry: (error, attempt, delayMs) => {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`[feishu] 启动失败（${msg}），${delayMs}ms 后第 ${attempt} 次重试`);
          updateStatus("connecting");
        },
      });
      gatewayLock.startHeartbeat();
      await gatewayLock.update("connected");
      updateStatus("connected");
      // 刚接过网关锁 = 很可能是一次 /restart 的结果：把上一张「重启中」卡片改成终态。
      // 失败不影响连接（回执只是体验），所以不 await 抛错。
      void ackRestartIfPending(startedTransport).catch(() => undefined);
      return "started";
    } catch (error) {
      updateStatus(error instanceof BotUnavailableError ? "bot unavailable" : "disconnected");
      await gatewayLock.release();
      gatewayLock = undefined;
      transport = undefined;
      throw error;
    }
  }

  async function stop() {
    await transport?.stop();
    transport = undefined;
    await gatewayLock?.release();
    gatewayLock = undefined;
    updateStatus(loadConfig() ? "disconnected" : "not configured");
  }

  function formatOwner(owner: GatewayOwner | undefined) {
    if (!owner) return "none";
    return `pid=${owner.pid}, status=${owner.status}, startedAt=${owner.startedAt}, heartbeatAt=${owner.heartbeatAt}, cwd=${owner.cwd}`;
  }

  function notifyDaemonStartResult(ctx: any, result: Awaited<ReturnType<typeof startDaemon>>) {
    if (result.status === "busy") {
      ctx.ui.notify(withBuildTag(`飞书连接已在后台运行。\n${formatOwner(result.owner)}`), "info");
      return;
    }
    const where = "dir" in result && result.dir ? `\n实例目录: ${result.dir}` : "";
    const log = "logPath" in result && result.logPath ? result.logPath : DAEMON_LOG_PATH;
    ctx.ui.notify(withBuildTag(`飞书连接已启动。\nGateway pid=${result.pid}${where}\nLog: ${log}`), "info");
  }

  // daemon 启动形状来自 feishu/daemon-spec.ts：/restart 的 worker 必须用完全相同的
  // 参数拉起新进程，否则 looksLikeFeishuDaemon() 认不出它（见该文件注释）。
  function daemonSpecForEntry() {
    return daemonSpec(extensionEntry);
  }

  function daemonCommandForEntry() {
    return daemonCommand(daemonSpecForEntry());
  }

  // ---------- 多实例（一个工作区多个机器人） ----------
  //
  // 架构基线不变：一个实例目录 = 一个自建应用 = 一个 daemon（见 feishu/instances.ts 顶部说明）。
  // 这里只把「启动/停止」从只认当前实例目录，扩到能指定任意实例目录。

  /** 当前进程绑定的实例目录（TUI 未设 FEISHU_DATA_DIR 时 = `<工作区>/.pi/feishu`）。 */
  function currentInstanceDir() {
    return resolveInstanceDir();
  }

  /**
   * 实例名 → 实例目录。
   * 未给名字 / `default` → 当前实例目录；名字非法 → `undefined`。
   */
  function dirForInstanceName(name?: string): string | undefined {
    const trimmed = (name || "").trim();
    if (!trimmed || trimmed === DEFAULT_INSTANCE_NAME) return currentInstanceDir();
    if (!isValidInstanceName(trimmed)) return undefined;
    return instanceDirForName(process.cwd(), trimmed);
  }

  function instanceDaemonLogPath(dir: string) {
    return dir === currentInstanceDir() ? DAEMON_LOG_PATH : join(dir, "daemon.log");
  }

  async function startDaemon(takeover = false, dir: string = currentInstanceDir()) {
    return withDaemonSpawnLock(async () => {
      const cfg = readInstanceConfig(dir);
      if (!cfg) {
        throw new Error(
          `实例目录缺少配置：${dir}\n先用 /feishu bots add <名字> 新建一个机器人，或 /feishu setup 配当前实例。`,
        );
      }
      const sameAsCurrent = dir === currentInstanceDir();
      let owner = readGatewayOwner(cfg.appId);
      if (owner && owner.pid !== process.pid && !takeover) {
        return { status: "busy" as const, owner };
      }

      // 本进程自己就是这个实例的持有者（daemon 里跑 /feishu start）时，先停掉自己的连接。
      if (sameAsCurrent && (owner?.pid === process.pid || transport?.isRunning())) {
        await stop();
      } else if (owner && takeover) {
        try { process.kill(owner.pid, "SIGTERM"); } catch {}
        await sleep(800);
      }

      // Re-check while holding the spawn lock. Another TUI may have started it
      // while this process was waiting for the lock.
      owner = readGatewayOwner(cfg.appId);
      if (owner && owner.pid !== process.pid && !takeover) {
        return { status: "busy" as const, owner };
      }

      reapDetachedDaemonProcesses({ keepPids: [process.pid], extensionPath: extensionEntry });
      // 当前实例沿用 ensureRoot()（含旧全局数据搬迁）；其它实例只建目录。
      if (sameAsCurrent) ensureRoot();
      else mkdirSync(dir, { recursive: true });
      const logPath = instanceDaemonLogPath(dir);
      const logFd = openSync(logPath, "a");
      // FEISHU_DATA_DIR 是 daemon 认实例的唯一依据：必须显式传，不能靠继承（TUI 自己可能没设）。
      const childEnv = { ...process.env, PI_FEISHU_DAEMON: "1", FEISHU_DATA_DIR: dir };
      let child: ChildProcess;
      if (process.platform === "win32") {
        // Windows 上 spawn("bash", ...) 可能解析到 WSL 的 bash.exe（而非 Git Bash），
        // 导致 daemon 在 WSL 环境里启动、路径和凭据全部错乱后立即退出。
        // 因此 Windows 直接用 node 拉起 Pi CLI 入口，绕开 bash 管道。
        const npmPrefix = process.env.APPDATA
          ? `${process.env.APPDATA}\\npm`
          : `${process.env.USERPROFILE}\\AppData\\Roaming\\npm`;
        const piCliEntry = process.env.PI_CLI_ENTRY
          || `${npmPrefix}\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js`;
        const { args } = daemonSpecForEntry();
        child = spawn("node", [piCliEntry, ...args], {
          detached: true,
          cwd: process.cwd(),
          env: childEnv,
          stdio: ["pipe", logFd, logFd],
        });
        // 保持 stdin 打开，等价于 Linux 侧 `tail -f /dev/null |` 的作用，
        // 否则 pi --mode rpc 会在 stdin EOF 后退出。
        if (child.stdin) (child.stdin as unknown as Readable).resume();
      } else {
        child = spawn("bash", ["-lc", daemonCommandForEntry()], {
          detached: true,
          cwd: process.cwd(),
          env: childEnv,
          stdio: ["ignore", logFd, logFd],
        });
      }
      child.unref();

      await sleep(1500);
      return {
        status: "started" as const,
        pid: child.pid,
        owner: readGatewayOwner(cfg.appId),
        dir,
        logPath,
      };
    });
  }

  async function stopDaemon(dir: string = currentInstanceDir()) {
    const owner = readGatewayOwner(readInstanceConfig(dir)?.appId);
    if (!owner) {
      reapDetachedDaemonProcesses({ extensionPath: extensionEntry });
      return { status: "none" as const };
    }
    if (owner.pid === process.pid) {
      await stop();
      reapDetachedDaemonProcesses({ keepPids: [process.pid], extensionPath: extensionEntry });
      return { status: "stopped-current" as const };
    }
    try {
      process.kill(owner.pid, "SIGTERM");
      await sleep(800);
      reapDetachedDaemonProcesses({ extensionPath: extensionEntry });
      return { status: "stopped" as const, owner };
    } catch (error) {
      return { status: "error" as const, owner, error };
    }
  }

  async function restartDaemon(dir: string = currentInstanceDir()) {
    const stopped = await stopDaemon(dir);
    if (stopped.status === "error") return { status: "error" as const, stopped };
    const started = await startDaemon(true, dir);
    return { status: "restarted" as const, stopped, started };
  }

  /** `/feishu bots` 的列表视图：名字、appId、连接状态（看网关锁）、目录。 */
  function describeInstances() {
    const current = currentInstanceDir();
    const instances = listInstances(process.cwd());
    if (!instances.length) return "还没有任何飞书实例。用 /feishu setup 配第一个，或 /feishu bots add <名字> 加第二个。";
    const lines = instances.map((instance) => {
      const marker = instance.dir === current ? "*" : " ";
      const name = instanceNameFromDir(process.cwd(), instance.dir) || instance.name;
      if (!instance.configured) return `${marker} ${name}\t未配置\t${instance.dir}`;
      const owner = readGatewayOwner(instance.appId);
      const state = owner
        ? `${owner.status}(pid=${owner.pid}, 心跳 ${owner.heartbeatAt.slice(11, 19)})`
        : "未运行";
      const port = instance.webhookPort ? ` port=${instance.webhookPort}` : "";
      return `${marker} ${name}\t${mask(instance.appId || "")}\t${state}\tautoStart=${instance.autoStart ? "on" : "off"}${port}\t${instance.dir}`;
    });
    return [
      `飞书实例（* = 当前 TUI 绑定的那个）：`,
      "``name	appId	状态	选项	目录``",
      ...lines,
    ].join("\n");
  }

  pi.registerCommand("feishu", {
    description: "Feishu/Lark: setup, start, stop, restart, status, bots, debug, autostart, reset, tools on|off, progress",
    handler: async (args, ctx) => {
      uiRef = ctx.ui as any;
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const cmd = (parts[0] || "status").toLowerCase();
      const cmdArg = (parts[1] || "").toLowerCase();
      const cmdArg2 = (parts[2] || "").toLowerCase();
      /** 解析 `/feishu bots <action> <名字>` 的目标目录；非法名字直接提示并返回 undefined。 */
      const instanceDirArg = (name: string): string | undefined => {
        const dir = dirForInstanceName(name);
        if (!dir) {
          ctx.ui.notify(
            `实例名不合法：${name || "(空)"}。只允许小写字母/数字/连字符，不能是 default。`,
            "error",
          );
          return undefined;
        }
        return dir;
      };
      try {
        if (cmd === "bots" || cmd === "instances") {
          const action = cmdArg;
          const name = cmdArg2;
          if (!action || action === "list") {
            ctx.ui.notify(describeInstances(), "info");
            return;
          }
          if (action === "add") {
            if (!name || !isValidInstanceName(name)) {
              ctx.ui.notify("用法：/feishu bots add <名字>（小写字母/数字/连字符，不能是 default）", "warning");
              return;
            }
            const dir = instanceDirForName(process.cwd(), name);
            if (readInstanceConfig(dir)) {
              ctx.ui.notify(`${name} 已经配置过了（${dir}）。要重连用 /feishu bots restart ${name}。`, "warning");
              return;
            }
            const configToStart = await runSetup(ctx, { configPath: instanceConfigPath(dir), dir });
            if (configToStart) {
              notifyDaemonStartResult(ctx, await startDaemon(false, dir));
            }
            ctx.ui.notify(describeInstances(), "info");
            return;
          }
          if (!name) {
            ctx.ui.notify(`用法：/feishu bots ${action} <名字>。先 /feishu bots 看有哪些实例。`, "warning");
            return;
          }
          const dir = instanceDirArg(name);
          if (!dir) return;
          if (action === "start") {
            notifyDaemonStartResult(ctx, await startDaemon(false, dir));
            return;
          }
          if (action === "restart") {
            const result = await restartDaemon(dir);
            if (result.status === "error") {
              ctx.ui.notify(`实例 ${name} 重启失败：${String((result.stopped as any)?.error ?? "")}`, "error");
              return;
            }
            notifyDaemonStartResult(ctx, result.started);
            return;
          }
          if (action === "stop") {
            const result = await stopDaemon(dir);
            ctx.ui.notify(result.status === "none" ? `实例 ${name} 未在运行。` : `实例 ${name} 已停止。`, "info");
            return;
          }
          if (action === "rm" || action === "remove") {
            if (dir === currentInstanceDir()) {
              ctx.ui.notify("默认实例不能删除，用 /feishu reset 清配置。", "warning");
              return;
            }
            const ok = await uiConfirm(
              ctx,
              `确认删除实例 ${name}？会停掉它的 daemon 并删除 ${dir}（该机器人的飞书会话映射、去重记录一并没了；pi 会话历史保留）。`,
              false,
            );
            if (!ok) {
              ctx.ui.notify("已取消。", "info");
              return;
            }
            await stopDaemon(dir);
            rmSync(dir, { recursive: true, force: true });
            ctx.ui.notify(`实例 ${name} 已删除。`, "info");
            ctx.ui.notify(describeInstances(), "info");
            return;
          }
          ctx.ui.notify("用法：/feishu bots [add|start|stop|restart|rm] <名字>", "warning");
          return;
        }
        if (cmd === "setup") {
          const configToStart = await runSetup(ctx);
          if (configToStart) {
            writeJson(CONFIG_PI_PATH, configToStart);
            notifyDaemonStartResult(ctx, await startDaemon(false));
          }
          refreshStatusFromState();
          return;
        }
        if (cmd === "start") {
          notifyDaemonStartResult(ctx, await startDaemon(false));
          refreshStatusFromState();
          return;
        }
        if (cmd === "stop") {
          const result = await stopDaemon();
          if (result.status === "error") {
            ctx.ui.notify(`停止飞书连接失败：${result.error instanceof Error ? result.error.message : String(result.error)}\nOwner: ${formatOwner(result.owner)}`, "error");
            refreshStatusFromState();
            return;
          }
          ctx.ui.notify(result.status === "none" ? "飞书连接未在运行。" : "飞书连接已停止。", "info");
          refreshStatusFromState();
          return;
        }
        if (cmd === "restart") {
          const result = await restartDaemon();
          if (result.status === "error") {
            const stopped = result.stopped;
            ctx.ui.notify(`飞书连接重启失败：${stopped.error instanceof Error ? stopped.error.message : String(stopped.error)}\nOwner: ${formatOwner(stopped.owner)}`, "error");
            refreshStatusFromState();
            return;
          }
          ctx.ui.notify(`飞书连接已重启，最新代码和配置已生效。\nOwner: ${formatOwner(result.started.owner)}\nLog: ${DAEMON_LOG_PATH}`, "info");
          refreshStatusFromState();
          return;
        }
        if (cmd === "reset") {
          const ok = await uiConfirm(
            ctx,
            "确认重置飞书扩展？会删除配置和会话映射，但保留所有会话历史。 / Reset Feishu extension? This deletes config and conversation mappings, but keeps all session history.",
            false,
          );
          if (!ok) {
            ctx.ui.notify("Reset cancelled / 已取消重置", "info");
            return;
          }
          await stopDaemon();
          removePath(CONFIG_PI_PATH);
          removePath(STATE_PI_PATH);
          removePath(DEDUPE_PI_PATH);
          removePath(`${DEDUPE_PI_PATH}.lock`);
          removePath(BRIDGE_PI_PATH);
          conversations.resetMemory();
          messageHandler.reset();
          ensureRoot();
          updateStatus("not configured");
          ctx.ui.notify(
            "Feishu extension reset. Session history was kept. Run /feishu setup. / 飞书扩展已重置，会话历史已保留，请运行 /feishu setup。",
            "info",
          );
          refreshStatusFromState();
          return;
        }
        if (cmd === "status") {
          refreshStatusFromState();
          const cfg = loadConfig();
          const owner = gatewayLock?.owner || currentGatewayOwner();
          ctx.ui.notify(
            [
              describeInstances(),
              "",
              `Status: ${lastStatusText || (loadConfig() ? "Feishu: disconnected" : "Feishu: not configured")}`,
              `Gateway owner: ${formatOwner(owner)}`,
              `Config: ${cfg ? `${cfg.domain}, appId=${mask(cfg.appId)}, groupPolicy=${cfg.groupPolicy}, autoStart=${cfg.autoStart !== false}` : "missing"}`,
              `Path: ${CONFIG_PI_PATH}`,
              `Gateway lock: ${gatewayLockPath()}`,
              `Debug: ${DEBUG_PI_LOG_PATH}`,
              `Gateway log: ${DAEMON_LOG_PATH}`,
            ].join("\n"),
            "info",
          );
          return;
        }
        if (cmd === "debug") {
          if (!existsSync(DEBUG_PI_LOG_PATH)) {
            ctx.ui.notify("还没有飞书调试日志。请先在飞书里发一条消息给机器人。", "info");
            return;
          }
          const lines = readFileSync(DEBUG_PI_LOG_PATH, "utf8").trim().split("\n").slice(-20);
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }
        if (cmd === "autostart") {
          const cfg = loadConfig();
          if (!cfg) {
            ctx.ui.notify("Missing config. Run /feishu setup first.", "warning");
            return;
          }
          cfg.autoStart = cfg.autoStart === false;
          writeJson(CONFIG_PI_PATH, cfg);
          ctx.ui.notify(cfg.autoStart ? "飞书自动启动已开启。" : "飞书自动启动已关闭。", "info");
          refreshStatusFromState();
          return;
        }
        if (cmd === "tools") {
          const active = pi.getActiveTools();
          const enabled = FEISHU_CONFIG_TOOLS.every((t) => active.includes(t));
          if (cmdArg === "on") {
            if (enabled) {
              ctx.ui.notify("飞书配置工具已启用。", "info");
              return;
            }
            pi.setActiveTools([...active, ...FEISHU_CONFIG_TOOLS]);
            ctx.ui.notify("飞书配置工具已启用（仅当前会话生效）。", "info");
            return;
          }
          if (cmdArg === "off") {
            if (!enabled) {
              ctx.ui.notify("飞书配置工具已隐藏。", "info");
              return;
            }
            hideFeishuConfigTools(pi);
            ctx.ui.notify("飞书配置工具已隐藏。", "info");
            return;
          }
          ctx.ui.notify(
            `飞书配置工具当前：${enabled ? "已启用" : "已隐藏"}。用 /feishu tools on|off 切换。`,
            "info",
          );
          return;
        }
        if (cmd === "progress") {
          const progressCfg = loadConfig();
          if (!cmdArg) {
            ctx.ui.notify(
              `飞书进度展示：${progressCfg?.progressMode ?? "off"}`
              + `（清单上限 ${progressCfg?.progressMaxLines ?? 50} 行，耗时阈值 ${progressCfg?.progressTimeoutSeconds ?? 30}s）\n`
              + "用法：/feishu progress steps | action | timeout | off",
              "info",
            );
            return;
          }
          // 写进 runtime-overrides 白名单：飞书侧 /config progressMode 也能改同一份
          const progressSet = setRuntimeConfig("progressMode", cmdArg);
          if (progressSet.ok === false) {
            ctx.ui.notify(progressSet.error, "error");
            return;
          }
          ctx.ui.notify(
            `飞书进度展示已设为 ${progressSet.value}（全局生效，下一轮回复起）`,
            "info",
          );
          return;
        }
        ctx.ui.notify("可用命令：/feishu setup | start | stop | restart | status | debug | autostart | reset | tools on|off | progress <mode>", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  const bootConfig = loadConfig();

  pi.on("session_start", async (_event, ctx) => {
    uiRef = ctx.ui as any;
    startStatusRefresh();
    if (foreignWorkspaceOwner) {
      ctx.ui.notify(
        `本目录不是该机器人的所属工作区（所属：${foreignWorkspaceOwner}），已跳过自动启动。\n` +
          "要多开：设 FEISHU_DATA_DIR 并用另一个自建应用的 appId/appSecret；确需在本目录临时接管请设 FEISHU_ALLOW_FOREIGN_WORKSPACE=1。",
        "warning",
      );
    }
    // 每个新会话默认隐藏配置工具，保持提示词干净；用户可用 /feishu tools on 打开。
    hideFeishuConfigTools(pi);
    // 多实例时启动就把「有几个机器人、各自 daemon 什么状态」摆出来，省得再去 /feishu status。
    if (multiInstanceStatusText()) ctx.ui.notify(describeInstances(), "info");
  });

  if (bootConfig?.autoStart) {
    // 裸开保护：未做实例隔离且这把锁属于**另一个目录**时，拒绝自动启动 ——
    // 否则会顶掉别的工作区的机器人连接（飞书长连接不广播，消息会随机落到错的工作区）。
    const foreignOwner = currentGatewayOwner();
    const recordedOwner = readOwnerWorkspace();
    if (isForeignWorkspace(foreignOwner?.cwd, process.cwd(), process.env, recordedOwner)) {
      foreignWorkspaceOwner = foreignOwner?.cwd ?? recordedOwner!;
      console.error(
        `[feishu] 本目录不是该机器人的所属工作区，已跳过自动启动：owner cwd=${foreignWorkspaceOwner}，本目录=${process.cwd()}。` +
          " 要多开请设 FEISHU_DATA_DIR 并配另一个自建应用；FEISHU_ALLOW_FOREIGN_WORKSPACE=1 可强制接管。",
      );
    } else if (process.env.PI_FEISHU_DAEMON === "1") {
      start().then((result) => {
        if (typeof result === "object" && result.status === "owned") {
          console.error("[feishu] daemon found existing owner, exiting:", formatOwner(result.owner));
          process.exit(0);
        }
      }).catch((error) => {
        updateStatus(error instanceof BotUnavailableError ? "bot unavailable" : "disconnected");
        console.error("[feishu] daemon autoStart failed:", error instanceof Error ? error.message : error);
        process.exit(1);
      });
    } else {
      startDaemon(false).catch((error) => {
        updateStatus("disconnected");
        console.error("[feishu] daemon spawn failed:", error instanceof Error ? error.message : error);
      });
    }
  }

  pi.on("session_shutdown", async () => {
    await stop();
    clearStatus();
  });
}

type DaemonProcessInfo = {
  pid: number;
  ppid: number;
  command: string;
};

// 导出仅供测试直接验证多开隔离（见 test/reap-instance.test.ts）。
export function reapDetachedDaemonProcesses(options: { keepPids?: number[]; extensionPath?: string } = {}) {
  if (process.platform === "win32") return;

  // 【必须带入口路径】没有明确的扩展入口就**不扫**（fail-safe）：
  // 2026-10-14 事故 —— 旧实现不传入口时回退到广谱匹配 `feishu/index.ts`，
  // 插件自己的 `npm test`（test/reap-instance.test.ts 在隔离 HOME 里跑 reap，
  // 真实 daemon 不在那把临时锁里）一次把两个工作区的 daemon 全 SIGTERM 掉，
  // 表现为「重启 pi 刚连上就断、只剩一个能用」。
  // 现在扫描只作用于**本实例扩展入口**拉起的 daemon：跨工作区的 daemon 即便无锁也不会被误杀。
  if (!options.extensionPath) {
    debugLog("feishu.reap.skipped_missing_extension_path", {});
    return;
  }

  // 多开（同机多个工作区）：同一条扩展入口可能被多个工作区共用（全局安装），
  // 所以「本实例入口匹配到的」还要再用网关锁判一次「有主」—— 被任何一把锁认领的
  // pid（及其后代）都保留，只回收没人认领的残留空壳（bash + tail）。见 gateway-lock.readAllGatewayOwnerPids。
  const keep = new Set([...(options.keepPids || []), ...readAllGatewayOwnerPids()]);
  const allProcesses = listProcesses();

  const byParent = new Map<number, DaemonProcessInfo[]>();
  for (const proc of allProcesses) {
    const children = byParent.get(proc.ppid) || [];
    children.push(proc);
    byParent.set(proc.ppid, children);
  }

  // 启动链与喂 stdin 的 tail 都不持锁，只锁住 pi 真身不够：
  // 壳（`bash -lc 'tail -f /dev/null | exec pi ...'`，外面还可能再套一层）被回收，
  // tail 就变孤儿，管道写端一关 → pi 的 stdin 直接 EOF → 那个工作区的桥接就掉线。
  // 所以每个被锁认领的 pid 要保**两条线**：
  //   ① 整条祖先链（外层 launcher 也可能命中根判据，得一起保，2026-10-14 二次事故的成因）；
  //   ② 它自己的整棵子树（多层中间壳、工具子进程）。
  // 注意②只对**持锁真身**展开，不能对整条祖先链展开：
  // 祖先里包含本次扫描者自己，对它展开会把「扫描者的兄弟进程」也一起保下来，
  // 无主残留空壳就再也回收不掉了（测试用例 `orphan.wrapper === false` 抓的就是这个）。
  const holders = [...keep];
  const parentOf = new Map(allProcesses.map((proc) => [proc.pid, proc.ppid]));
  for (const pid of holders) {
    let parent = parentOf.get(pid);
    for (let hops = 0; parent && parent > 1 && hops < 32; hops += 1) {
      keep.add(parent);
      parent = parentOf.get(parent);
    }
  }
  for (const pid of holders) collectSubtreePids(pid, byParent, keep);

  const roots = allProcesses.filter((proc) => looksLikeFeishuDaemon(proc.command, options.extensionPath));
  if (!roots.length) return;

  const keptRoots = roots.filter((proc) => keep.has(proc.pid));
  if (keptRoots.length) {
    debugLog("feishu.reap.kept_locked_daemons", {
      pids: keptRoots.map((proc) => proc.pid),
      candidates: roots.length,
    });
  }

  const toKill = new Set<number>();
  for (const proc of roots) {
    // 自己这条不算：本进程命令行里也会出现这些字串，把自己当成根会把**自己名下的子进程**
    // 当残留回收（工具子进程、别的 agent 都会被误杀）。
    if (proc.pid === process.pid) continue;
    if (keep.has(proc.pid)) continue;
    toKill.add(proc.pid);
    collectDescendantPids(proc.pid, byParent, toKill, keep);
  }

  for (const pid of [...toKill].sort((a, b) => b - a)) {
    if (keep.has(pid) || pid === process.pid) continue;
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
}

function collectDescendantPids(pid: number, byParent: Map<number, DaemonProcessInfo[]>, toKill: Set<number>, keep: Set<number>) {
  for (const child of byParent.get(pid) || []) {
    if (keep.has(child.pid)) continue;
    toKill.add(child.pid);
    collectDescendantPids(child.pid, byParent, toKill, keep);
  }
}

/** 把一个 pid 的整棵子树并进 `out`（含多层中间壳）：用于「活着的 daemon 全家都不许动」。 */
function collectSubtreePids(rootPid: number, byParent: Map<number, DaemonProcessInfo[]>, out: Set<number>) {
  const stack = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (stack.length) {
    const pid = stack.pop() as number;
    for (const child of byParent.get(pid) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.add(child.pid);
      stack.push(child.pid);
    }
  }
}

function listProcesses() {
  const result = spawnSync("ps", ["-wwaxo", "pid=,ppid=,command="], { encoding: "utf8" });
  if (result.status !== 0) return [] as DaemonProcessInfo[];

  const processes: DaemonProcessInfo[] = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const command = match[3] || "";
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    processes.push({ pid, ppid, command });
  }
  return processes;
}

function looksLikeFeishuDaemon(command: string, extensionPath: string) {
  // 启动命令经 quoteShell 处理，每个参数单独加引号（'--mode' 'rpc'），
  // 直接匹配 "--mode rpc" 永远失败 —— 那样残留的 daemon 空壳（bash + tail 喂 stdin）
  // 永远不会被 reap 掉。所以先去引号再匹配。
  //
  // 2026-11-13 起 daemon 不再带 --no-* 开关（与 TUI 等同），判据改为三件套：
  // rpc 模式 + 给 stdin 续命的 `tail -f /dev/null` + `-e` 紧跟本实例入口。
  // 只「引用了启动命令」的脚本 / heredoc 缺那只 tail，仍然认不出来。
  const normalized = command.replace(/'/g, "");
  const hasDaemonShape = normalized.includes("--mode rpc")
    && normalized.includes("tail -f /dev/null");
  if (!hasDaemonShape) return false;
  if (!extensionPath) return false;
  // 入口路径必须**紧跟在 `-e` 后面**（daemon 的启动形状），而不是「命令行里提到过这个路径」：
  // 否则一段只是引用了启动命令的脚本 / heredoc（测试探针、重启脚本）也会被当成 daemon 回收。
  return normalized.includes(`-e ${extensionPath}`);
}

/**
 * 收掉 daemon 的启动壳 `bash -lc 'tail -f /dev/null | exec pi …'`。
 *
 * 只 kill 父 bash 是不够的：`tail -f /dev/null` 是它的**兄弟子进程**，父 bash 一死就被
 * reparent 到 init，永久挂着——每重启一次漏一个（2026-10-23 实测：一次 /restart 后
 * 孤儿 tail 从 7 涨到 8）。所以安全时按进程组整组收。
 *
 * 安全边界：detached spawn 的 launcher 自成一组（pgid == pid），组里只有 bash + tail + 本进程；
 * 命令行里必须同时出现 `tail -f /dev/null` 与 `feishu/index.ts` 才动手，
 * 否则（比如在用户终端里前台跑）宁可什么都不杀。
 */
function terminateLauncherParent() {
  if (process.platform === "win32") return;
  const parentPid = process.ppid;
  if (!parentPid || parentPid <= 1) return;

  const result = spawnSync("ps", ["-wwaxo", "pid=,pgid=,command="], { encoding: "utf8" });
  if (result.status !== 0) return;

  const line = result.stdout.split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${parentPid} `));
  if (!line) return;
  if (!line.includes("tail -f /dev/null") || !line.includes("feishu/index.ts")) return;
  const pgid = Number(line.split(/\s+/)[1]);
  if (Number.isFinite(pgid) && pgid === parentPid) {
    try {
      process.kill(-pgid, "SIGTERM");
      return;
    } catch {}
  }
  try { process.kill(parentPid, "SIGTERM"); } catch {}
}

async function withDaemonSpawnLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = `${gatewayLockPath()}.spawn.lock`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (tryAcquireSpawnLock(lockPath)) {
      try {
        return await fn();
      } finally {
        try { rmSync(lockPath, { recursive: true, force: true }); } catch {}
      }
    }
    await sleep(25);
  }
  // Last resort: run without the spawn lock. The daemon-side gateway lock still
  // prevents duplicate live Feishu connections.
  return fn();
}

function tryAcquireSpawnLock(lockPath: string) {
  try {
    mkdirSync(lockPath, { recursive: false });
    return true;
  } catch {
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age > 30_000) rmSync(lockPath, { recursive: true, force: true });
    } catch {}
    return false;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textToolResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
  };
}

// feishu_config_* 工具名单：默认从提示词隐藏，可用 /feishu tools on|off 切换。
const FEISHU_CONFIG_TOOLS = [
  "feishu_config_get",
  "feishu_config_set",
  "feishu_config_clear",
];

function hideFeishuConfigTools(pi: ExtensionAPI) {
  const active = pi.getActiveTools();
  const filtered = active.filter((t) => !FEISHU_CONFIG_TOOLS.includes(t));
  if (filtered.length !== active.length) {
    pi.setActiveTools(filtered);
  }
}

function registerFeishuConfigTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "feishu_config_get",
    label: "Feishu Config Get",
    description:
      "Read Feishu runtime config whitelist (groupPolicy, groupKeywords, streaming, etc). Secrets are never returned.",
    promptSnippet: "Read Feishu bot runtime settings (keywords, mention policy, streaming).",
    parameters: Type.Object({}),
    async execute() {
      const cfg = loadConfig();
      if (!cfg) {
        return textToolResult("Feishu config unavailable (missing FEISHU_APP_ID/SECRET).");
      }
      return textToolResult(formatRuntimeConfig(cfg, getRuntimeOverrides()));
    },
  });

  pi.registerTool({
    name: "feishu_config_set",
    label: "Feishu Config Set",
    description:
      `Set a Feishu runtime config key. HOT-RELOADS immediately and persists to runtime-overrides.json — NEVER tell the user to restart the container or edit docker-compose.yml. Allowed keys: ${RUNTIME_CONFIG_KEYS.join(", ")}. Do not set appId/appSecret.`,
    promptSnippet: "Update Feishu group trigger keywords / streaming / emoji at runtime (no restart).",
    promptGuidelines: [
      "Only use whitelisted keys; never attempt to set app credentials.",
      "After set, subsequent group messages use the new settings immediately — no docker restart.",
      "Never edit docker-compose.yml or env files for these settings; use this tool only.",
    ],
    parameters: Type.Object({
      key: Type.String({ description: `One of: ${RUNTIME_CONFIG_KEYS.join(", ")}` }),
      value: Type.String({ description: "New value (keywords comma-separated; bool true/false; numbers as digits)" }),
    }),
    async execute(_id, params) {
      const key = String((params as any)?.key || "").trim();
      const value = String((params as any)?.value ?? "");
      if (!key) return textToolResult("key is required");
      const result = setRuntimeConfig(key, value);
      if (result.ok === false) return textToolResult(`Error: ${result.error}`);
      const cfg = loadConfig();
      return textToolResult(
        [
          `Updated ${result.key} = ${Array.isArray(result.value) ? result.value.join(", ") : String(result.value)}`,
          "Hot-reloaded and persisted (runtime-overrides.json).",
          "",
          cfg ? formatRuntimeConfig(cfg, getRuntimeOverrides()) : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
  });

  pi.registerTool({
    name: "feishu_config_clear",
    label: "Feishu Config Clear",
    description: "Clear one runtime override key or all overrides (reverts to env/base config).",
    parameters: Type.Object({
      key: Type.Optional(Type.String({ description: "Whitelist key, or omit/all for all overrides" })),
    }),
    async execute(_id, params) {
      const target = String((params as any)?.key || "all").trim() || "all";
      const result = clearRuntimeOverrides(target);
      if (result.ok === false) return textToolResult(`Error: ${result.error}`);
      const cfg = loadConfig();
      return textToolResult(
        [
          target === "all" ? "Cleared all runtime overrides." : `Cleared override: ${target}`,
          "",
          cfg ? formatRuntimeConfig(cfg, getRuntimeOverrides()) : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
  });
}
