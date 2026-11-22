import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AUTOSTART_LABEL,
  installLaunchAgent,
  readAutostartRegistry,
  removeAutostartEntry,
  renderLaunchAgentPlist,
  setLaunchctlRunner,
  uninstallLaunchAgent,
  upsertAutostartEntry,
  writeAutostartRegistry,
  xmlEscape,
  type AutostartEntry,
} from "../src/feishu/autostart.ts";
import { daemonCommand, daemonSpec } from "../src/feishu/daemon-spec.ts";
import {
  buildDaemonCommand,
  planTick,
  scanInstanceDirs,
} from "../scripts/autostart-supervisor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const supervisorPath = join(here, "..", "scripts", "autostart-supervisor.mjs");

function tempDir(prefix = "feishu-autostart-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function entry(workspace: string, extra: Partial<AutostartEntry> = {}): AutostartEntry {
  return {
    workspace,
    extensionPath: join(workspace, ".pi/extensions/feishu/index.ts"),
    piBin: "/usr/local/bin/pi",
    nodeBin: "/usr/local/bin/node",
    addedAt: "2026-11-22T00:00:00.000Z",
    updatedAt: "2026-11-22T00:00:00.000Z",
    ...extra,
  };
}

/** 在工作区里造一个实例目录（default = .pi/feishu，其余 = .pi/feishu-<name>）。 */
function writeInstance(workspace: string, name: string, config: Record<string, unknown>) {
  const dir = name === "default" ? join(workspace, ".pi", "feishu") : join(workspace, ".pi", `feishu-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.pi.json"), JSON.stringify(config), "utf8");
  return dir;
}

test("TC-AUTOSTART-PLIST-01 plist 关键字段：/bin/sh + launcher、RunAtLoad、KeepAlive 只随崩溃重启", () => {
  const plist = renderLaunchAgentPlist({
    launcherPath: "/pkg/scripts/autostart-launch.sh",
    workingDirectory: "/Users/me/work",
    logPath: "/tmp/autostart.log",
    pathHint: "/usr/local/bin:/usr/bin:/bin",
  });
  assert.match(plist, new RegExp(`<string>${AUTOSTART_LABEL}</string>`));
  // 不写死 node：ProgramArguments 只有 /bin/sh 与 launcher 两个字符串
  assert.match(plist, /<key>ProgramArguments<\/key>\n  <array>\n    <string>\/bin\/sh<\/string>\n    <string>\/pkg\/scripts\/autostart-launch\.sh<\/string>\n  <\/array>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\n  <true\/>/);
  // 退出码 0（注册表空）不再拉起，否则关自启 = 无限重启
  assert.match(plist, /<key>KeepAlive<\/key>\n  <dict>\n    <key>SuccessfulExit<\/key>\n    <false\/>\n  <\/dict>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\n  <integer>30<\/integer>/);
  assert.match(plist, /<string>\/Users\/me\/work<\/string>/);
  assert.equal((plist.match(/<string>\/tmp\/autostart\.log<\/string>/g) ?? []).length, 2);
  assert.doesNotMatch(plist, /node/);
});

test("TC-AUTOSTART-PLIST-02 路径里的 XML 特殊字符被转义", () => {
  assert.equal(xmlEscape(`a&b<c>"d"`), "a&amp;b&lt;c&gt;&quot;d&quot;");
  const plist = renderLaunchAgentPlist({ launcherPath: "/pkg/a&b/launch.sh" });
  assert.match(plist, /<string>\/pkg\/a&amp;b\/launch\.sh<\/string>/);
});

test("TC-AUTOSTART-REG-01 登记/更新/移除：按工作区分条，重复登记只更新时间", () => {
  const dir = tempDir();
  const registryPath = join(dir, "registry.json");
  const workspaceA = join(dir, "ws-a");
  const workspaceB = join(dir, "ws-b");
  try {
    const first = upsertAutostartEntry(entry(workspaceA), registryPath);
    assert.equal(first.added, true);
    assert.equal(Object.keys(first.registry.entries).length, 1);
    const firstAddedAt = first.registry.entries[workspaceA].addedAt;

    const second = upsertAutostartEntry(entry(workspaceA), registryPath);
    assert.equal(second.added, false);
    assert.equal(Object.keys(second.registry.entries).length, 1);
    // 已登记过就保留首次 addedAt（用于「这台机器何时开始自启」）
    assert.equal(second.registry.entries[workspaceA].addedAt, firstAddedAt);

    upsertAutostartEntry(entry(workspaceB), registryPath);
    assert.deepEqual(Object.keys(readAutostartRegistry(registryPath).entries).sort(), [workspaceA, workspaceB].sort());

    const removed = removeAutostartEntry(workspaceA, registryPath);
    assert.equal(removed.removed, true);
    assert.deepEqual(Object.keys(removed.registry.entries), [workspaceB]);

    const again = removeAutostartEntry(workspaceA, registryPath);
    assert.equal(again.removed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TC-AUTOSTART-REG-02 注册表损坏/不存在时回落空表，不抛错", () => {
  const dir = tempDir();
  const registryPath = join(dir, "registry.json");
  try {
    assert.deepEqual(readAutostartRegistry(registryPath), { version: 1, entries: {} });
    writeFileSync(registryPath, "{ not json", "utf8");
    assert.deepEqual(readAutostartRegistry(registryPath), { version: 1, entries: {} });
    writeFileSync(registryPath, JSON.stringify({ version: 1, entries: "bad" }), "utf8");
    assert.deepEqual(readAutostartRegistry(registryPath), { version: 1, entries: {} });
    writeAutostartRegistry({ version: 1, entries: {} }, registryPath);
    assert.deepEqual(JSON.parse(readFileSync(registryPath, "utf8")), { version: 1, entries: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TC-AUTOSTART-INSTALL-01 未加载时走 bootstrap，已加载时走 kickstart -k", () => {
  const dir = tempDir();
  const plistPath = join(dir, "com.test.autostart.plist");
  const calls: string[][] = [];
  let loaded = false;
  const restore = setLaunchctlRunner((args: string[]) => {
    calls.push(args);
    if (args[0] === "print") return { ok: loaded, output: loaded ? "" : "not found" };
    if (args[0] === "bootstrap") {
      loaded = true;
      return { ok: true, output: "" };
    }
    if (args[0] === "kickstart") return { ok: true, output: "" };
    return { ok: false, output: "unexpected" };
  });
  try {
    const first = installLaunchAgent({ launcherPath: "/pkg/launch.sh" }, plistPath);
    assert.equal(first.ok, true);
    assert.equal(first.reloaded, false);
    assert.ok(existsSync(plistPath));
    assert.deepEqual(calls.map((c) => c[0]), ["print", "bootstrap"]);
    assert.equal(calls[1][2], plistPath);

    calls.length = 0;
    const second = installLaunchAgent({ launcherPath: "/pkg/launch.sh" }, plistPath);
    assert.equal(second.ok, true);
    assert.equal(second.reloaded, true);
    assert.deepEqual(calls.map((c) => c[0]), ["print", "kickstart"]);
    assert.deepEqual(calls[1].slice(0, 2), ["kickstart", "-k"]);
    assert.equal(calls[1][2], `gui/${typeof process.getuid === "function" ? process.getuid() : 0}/${AUTOSTART_LABEL}`);
  } finally {
    setLaunchctlRunner(restore);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TC-AUTOSTART-INSTALL-02 bootstrap 报 already exists 时退一步 kickstart", () => {
  const dir = tempDir();
  const plistPath = join(dir, "x.plist");
  const calls: string[][] = [];
  const restore = setLaunchctlRunner((args) => {
    calls.push(args);
    if (args[0] === "print") return { ok: false, output: "not found" };
    if (args[0] === "bootstrap") return { ok: false, output: "Bootstrap failed: 5: Input/output error\nalready bootstrapped" };
    if (args[0] === "kickstart") return { ok: true, output: "" };
    return { ok: false, output: "" };
  });
  try {
    const result = installLaunchAgent({ launcherPath: "/pkg/launch.sh" }, plistPath);
    assert.equal(result.ok, true);
    assert.equal(result.reloaded, true);
    assert.deepEqual(calls.map((c) => c[0]), ["print", "bootstrap", "kickstart"]);
  } finally {
    setLaunchctlRunner(restore);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TC-AUTOSTART-INSTALL-03 未加载时卸载不报错，且 plist 被删除", () => {
  const dir = tempDir();
  const plistPath = join(dir, "y.plist");
  writeFileSync(plistPath, "placeholder", "utf8");
  const calls: string[][] = [];
  const restore = setLaunchctlRunner((args) => {
    calls.push(args);
    if (args[0] === "bootout") return { ok: false, output: "No such process" };
    if (args[0] === "print") return { ok: false, output: "not found" };
    return { ok: false, output: "" };
  });
  try {
    const result = uninstallLaunchAgent(plistPath);
    assert.equal(result.ok, true);
    assert.equal(existsSync(plistPath), false);
    assert.deepEqual(calls.map((c) => c[0]), ["bootout", "print"]);
  } finally {
    setLaunchctlRunner(restore);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TC-AUTOSTART-SUP-01 supervisor 拼出的 daemon 命令与 daemon-spec 完全一致", () => {
  const previous = process.env.PI_BIN;
  process.env.PI_BIN = "/opt/pi/bin/pi";
  try {
    const extensionPath = "/Users/x/weird dir/it's/index.ts";
    const spec = daemonSpec(extensionPath);
    assert.equal(buildDaemonCommand(spec.piBin, extensionPath), daemonCommand(spec));
    assert.match(buildDaemonCommand(spec.piBin, extensionPath), /^tail -f \/dev\/null \| exec /);
    assert.match(buildDaemonCommand(spec.piBin, extensionPath), /'\/Users\/x\/weird dir\/it'\\''s\/index\.ts'$/);
  } finally {
    if (previous === undefined) delete process.env.PI_BIN;
    else process.env.PI_BIN = previous;
  }
});

test("TC-AUTOSTART-SUP-02 scanInstanceDirs 只认有 config.pi.json 的 default 与 feishu-<name>", () => {
  const dir = tempDir();
  try {
    const workspace = join(dir, "ws");
    writeInstance(workspace, "default", { appId: "cli_default" });
    writeInstance(workspace, "duocheck", { appId: "cli_duo" });
    // 非法实例名与空目录都应被跳过
    mkdirSync(join(workspace, ".pi", "feishu-Bad_Name"), { recursive: true });
    mkdirSync(join(workspace, ".pi", "feishu-empty"), { recursive: true });
    const found = scanInstanceDirs(workspace);
    assert.deepEqual(found.map((i: { name: string }) => i.name).sort(), ["default", "duocheck"]);
    assert.deepEqual(scanInstanceDirs(join(dir, "nope")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TC-AUTOSTART-SUP-03 planTick 的四种原因：dead / starting / owner-elsewhere / no-instance", () => {
  const dir = tempDir();
  try {
    const workspace = join(dir, "ws");
    const other = join(dir, "other");
    mkdirSync(join(other, ".pi"), { recursive: true });
    const deadDir = writeInstance(workspace, "default", { appId: "cli_dead", appSecret: "s" });
    writeInstance(workspace, "live", { appId: "cli_live", appSecret: "s" });
    writeInstance(workspace, "elsewhere", { appId: "cli_elsewhere", appSecret: "s" });
    writeInstance(workspace, "off", { appId: "cli_off", appSecret: "s", autoStart: false });
    const emptyWorkspace = join(dir, "empty-ws");
    mkdirSync(join(emptyWorkspace, ".pi"), { recursive: true });

    const now = Date.now();
    const alive = (pid: number, cwd: string) => ({
      pid,
      cwd,
      status: "connected",
      startedAt: new Date(now - 1000).toISOString(),
      heartbeatAt: new Date(now - 500).toISOString(),
    });
    const locks = {
      "ax-feishu-bridge.gateway.cli_live": alive(process.pid, workspace),
      "ax-feishu-bridge.gateway.cli_elsewhere": alive(process.pid, other),
    };
    const registry = {
      version: 1,
      entries: { [workspace]: entry(workspace), [emptyWorkspace]: entry(emptyWorkspace) },
    };

    const plan = planTick(registry, locks, now);
    const byInstance = new Map(plan.map((a: { workspace: string; instance: string; reason: string }) => [`${a.workspace}:${a.instance}`, a.reason]));
    assert.equal(byInstance.get(`${workspace}:default`), "dead");
    assert.equal(byInstance.get(`${workspace}:live`), "starting");
    assert.equal(byInstance.get(`${workspace}:elsewhere`), "owner-elsewhere");
    assert.equal(byInstance.has(`${workspace}:off`), false, "autoStart:false 的实例不参与自启");
    assert.equal(byInstance.get(`${emptyWorkspace}:-`), "no-instance");
    assert.deepEqual(plan.find((a: { instance: string }) => a.instance === "default").dir, deadDir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TC-AUTOSTART-SUP-04 --once --dry-run 端到端：只输出计划，不真起进程", () => {
  const dir = tempDir();
  try {
    const workspace = join(dir, "ws");
    mkdirSync(join(workspace, ".pi"), { recursive: true });
    writeInstance(workspace, "default", { appId: "cli_dry", appSecret: "s" });
    const registryPath = join(dir, "registry.json");
    const locksPath = join(dir, "locks.json");
    const logPath = join(dir, "supervisor.log");
    writeFileSync(
      registryPath,
      JSON.stringify({ version: 1, entries: { [workspace]: entry(workspace, { piBin: process.execPath }) } }),
      "utf8",
    );
    writeFileSync(locksPath, "{}", "utf8");

    const run = spawnSync(
      process.execPath,
      [supervisorPath, "--once", "--dry-run", `--registry=${registryPath}`, `--locks=${locksPath}`, `--log=${logPath}`],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(run.status, 0, run.stderr);
    const output = JSON.parse(run.stdout);
    assert.equal(output.spawned.length, 1);
    assert.equal(output.spawned[0].reason, "dead");
    assert.equal(output.spawned[0].dryRun, true);
    assert.equal(output.spawned[0].workspace, workspace);
    assert.equal(output.spawned[0].pid, undefined, "dry-run 不允许真的拉起进程");
    assert.ok(existsSync(logPath), "启动与巡检痕迹要落在日志里");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
