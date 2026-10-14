import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  explicitInstanceDir,
  instanceWebhookPort,
  isForeignWorkspace,
  ownerWorkspacePath,
  readOwnerWorkspace,
  readOwnerWorkspaceAt,
  sameWorkspace,
  writeOwnerWorkspace,
  resolveInstanceDir,
  resolveRootDir,
  workspaceInstanceDir,
} from "../src/feishu/instance.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = ["--experimental-strip-types", "-e"];

/** 跑一段子进程探针，返回 stdout 解析后的对象（cwd / env 由调用方决定）。 */
function probe(script: string, cwd: string, env: NodeJS.ProcessEnv, expectStatus = 0): { stdout: string; stderr: string; json?: any } {
  // 默认剥掉 NODE_TEST_CONTEXT：否则探针会被当成测试进程而跳过迁移。
  // 要模拟「测试进程」本身时传 ALLOW_NODE_TEST_CONTEXT=1（下面会转成 NODE_TEST_CONTEXT=1）。
  const base = { ...process.env };
  delete base.NODE_TEST_CONTEXT;
  const childEnv: NodeJS.ProcessEnv = { ...base, ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  if (childEnv.ALLOW_NODE_TEST_CONTEXT === "1") childEnv.NODE_TEST_CONTEXT = "1";
  delete childEnv.ALLOW_NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [...NODE, script], { cwd, env: childEnv, encoding: "utf8" });
  assert.equal(result.status, expectStatus, `子进程应退出码 ${expectStatus}，实际 ${result.status}：${result.stderr}`);
  const trimmed = result.stdout.trim();
  return { stdout: result.stdout, stderr: result.stderr, json: trimmed ? JSON.parse(trimmed) : undefined };
}

const CONFIG_PROBE = [
  `import * as cfg from ${JSON.stringify(join(REPO_ROOT, "src", "feishu", "config.ts"))};`,
  "cfg.ensureRoot();", // 迁移发生在这里，探针必须真的跑一次
  "console.log(JSON.stringify({",
  "  root: cfg.ROOT_DIR,",
  "  state: cfg.STATE_PI_PATH,",
  "  config: cfg.CONFIG_PI_PATH,",
  "  daemonLog: cfg.DAEMON_LOG_PATH,",
  "  port: cfg.defaultCardActionWebhookPort(),",
  "}));",
].join("\n");

test("默认跟着工作区走：实例目录 = <工作区>/.pi/feishu（没有全局实例）", () => {
  const ws = "/tmp/feishu-ws-a";
  assert.equal(explicitInstanceDir({}), undefined);
  assert.equal(resolveInstanceDir({}, ws), join(ws, ".pi", "feishu"));
  assert.equal(resolveRootDir({}, ws), join(ws, ".pi", "feishu"));
  assert.equal(workspaceInstanceDir(ws), join(ws, ".pi", "feishu"));
  // 不同工作区天然互不相同
  assert.notEqual(resolveRootDir({}, ws), resolveRootDir({}, "/tmp/feishu-ws-b"));
});

test("FEISHU_DATA_DIR 为空串或纯空白等同于未设（仍跟着工作区走）", () => {
  const ws = "/tmp/feishu-ws-a";
  assert.equal(explicitInstanceDir({ FEISHU_DATA_DIR: "" }), undefined);
  assert.equal(explicitInstanceDir({ FEISHU_DATA_DIR: "   " }), undefined);
  assert.equal(resolveInstanceDir({ FEISHU_DATA_DIR: "" }, ws), join(ws, ".pi", "feishu"));
  assert.equal(resolveInstanceDir({ FEISHU_DATA_DIR: "   " }, ws), join(ws, ".pi", "feishu"));
});

test("FEISHU_DATA_DIR 显式指定时优先", () => {
  const dir = "/tmp/feishu-inst-a";
  const env = { FEISHU_DATA_DIR: dir };
  assert.equal(explicitInstanceDir(env), dir);
  assert.equal(resolveInstanceDir(env, "/tmp/feishu-ws-a"), dir);
  assert.equal(resolveRootDir(env, "/tmp/feishu-ws-a"), dir);
});

test("FEISHU_DATA_DIR 支持 ~ 展开与相对路径转绝对路径", () => {
  assert.equal(explicitInstanceDir({ FEISHU_DATA_DIR: "~" }), homedir());
  assert.equal(explicitInstanceDir({ FEISHU_DATA_DIR: "~/feishu-b" }), join(homedir(), "feishu-b"));
  const rel = explicitInstanceDir({ FEISHU_DATA_DIR: "feishu-c" });
  assert.ok(rel && rel.startsWith("/"), `相对路径应转为绝对路径，实际 ${rel}`);
});

test("端口：一律按实例目录派生到 3003-3099，同一目录稳定、不同目录不同", () => {
  const ws = "/tmp/feishu-ws-a";
  const derived = instanceWebhookPort(3001, {}, ws);
  assert.ok(derived >= 3003 && derived <= 3099, `派生端口应在 3003-3099，实际 ${derived}`);
  // 同一目录重复调用必须稳定（飞书后台的回调地址只需配一次）
  assert.equal(instanceWebhookPort(3001, {}, ws), derived);
  // base 参与派生：同一目录下传不同 base 应得到不同端口
  assert.notEqual(instanceWebhookPort(3001, {}, ws), instanceWebhookPort(3002, {}, ws));
  // 显式实例目录同样生效、且与工作区默认目录不同
  assert.ok(instanceWebhookPort(3001, { FEISHU_DATA_DIR: "/tmp/feishu-inst-a" }, ws) >= 3003);

  const ports = new Set<number>();
  for (let i = 0; i < 12; i += 1) ports.add(instanceWebhookPort(3001, {}, `/tmp/feishu-ws-${i}`));
  assert.ok(ports.size > 1, "12 个不同工作区不应全部落到同一个端口");
});

test("端到端：未设 FEISHU_DATA_DIR 时 config.ts 的落盘路径跟着 cwd 走", () => {
  const home = mkdtempSync(join(tmpdir(), "feishu-home-"));
  const ws = join(home, "ws");
  mkdirSync(ws, { recursive: true });
  const base = realpathSync(ws);
  try {
    const { json } = probe(CONFIG_PROBE, ws, { ...process.env, HOME: home });
    assert.equal(json.root, join(base, ".pi", "feishu"));
    assert.equal(json.state, join(base, ".pi", "feishu", "state.pi.json"));
    assert.equal(json.config, join(base, ".pi", "feishu", "config.pi.json"));
    assert.equal(json.daemonLog, join(base, ".pi", "feishu", "daemon.log"));
    assert.ok(json.port >= 3003 && json.port <= 3099, `端口应在 3003-3099，实际 ${json.port}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("端到端：设了 FEISHU_DATA_DIR 时落盘路径整体落到该目录", () => {
  const home = mkdtempSync(join(tmpdir(), "feishu-home-"));
  const instanceDir = join(home, "instance");
  try {
    const { json } = probe(CONFIG_PROBE, REPO_ROOT, {
      ...process.env,
      HOME: home,
      FEISHU_DATA_DIR: instanceDir,
    });
    assert.equal(json.root, instanceDir);
    assert.equal(json.state, join(instanceDir, "state.pi.json"));
    assert.equal(json.config, join(instanceDir, "config.pi.json"));
    assert.equal(json.daemonLog, join(instanceDir, "daemon.log"));
    assert.ok(json.port >= 3003 && json.port <= 3099, `派生端口应在 3003-3099，实际 ${json.port}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("迁移：旧全局目录的属主是本工作区 → 整份搬到工作区实例目录", () => {
  const home = mkdtempSync(join(tmpdir(), "feishu-home-"));
  const ws = join(home, "ws");
  const legacy = join(home, ".pi", "agent", "feishu");
  mkdirSync(legacy, { recursive: true });
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(legacy, "config.pi.json"), '{"appId":"cli_x"}\n', "utf8");
  writeFileSync(join(legacy, "owner-workspace.json"), JSON.stringify({ cwd: realpathSync(ws) }), "utf8");
  try {
    const { stderr } = probe(CONFIG_PROBE, ws, { ...process.env, HOME: home });
    const moved = join(realpathSync(ws), ".pi", "feishu");
    assert.ok(existsSync(join(moved, "config.pi.json")), `旧配置应搬到 ${moved}`);
    assert.ok(!existsSync(legacy), "旧全局目录应已整体搬走（不残留半份数据）");
    assert.match(stderr, /已把旧全局实例数据搬到工作区实例目录/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("迁移：旧全局目录的属主是别的工作区 → 不动它，只打印提示", () => {
  const home = mkdtempSync(join(tmpdir(), "feishu-home-"));
  const ws = join(home, "ws");
  const legacy = join(home, ".pi", "agent", "feishu");
  mkdirSync(legacy, { recursive: true });
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(legacy, "config.pi.json"), '{"appId":"cli_x"}\n', "utf8");
  writeFileSync(join(legacy, "owner-workspace.json"), JSON.stringify({ cwd: join(home, "somewhere-else") }), "utf8");
  try {
    const { json, stderr } = probe(CONFIG_PROBE, ws, { ...process.env, HOME: home });
    assert.ok(existsSync(join(legacy, "config.pi.json")), "别的工作区的数据必须原样留着");
    assert.equal(json.root, join(realpathSync(ws), ".pi", "feishu"));
    assert.match(stderr, /不属于本工作区/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("外来工作区保护：锁 owner 属于另一个目录 → 判为外来", () => {
  assert.equal(isForeignWorkspace("/Users/a/proj", "/Users/a/other", {}), true);
});

test("外来工作区保护：owner 就是本目录（含尾斜杠差异）→ 不算外来", () => {
  assert.equal(isForeignWorkspace("/Users/a/proj", "/Users/a/proj", {}), false);
  assert.equal(isForeignWorkspace("/Users/a/proj/", "/Users/a/proj", {}), false);
});

test("外来工作区保护：在子目录里启动 pi 也算同一个工作区", () => {
  assert.equal(isForeignWorkspace("/Users/a/proj", "/Users/a/proj/sub", {}), false);
  assert.equal(isForeignWorkspace("/Users/a/proj/sub", "/Users/a/proj", {}), false);
});

test("外来工作区保护：没有 owner（本机从未起过 daemon）→ 放行", () => {
  assert.equal(isForeignWorkspace(undefined, "/Users/a/proj", {}), false);
  assert.equal(isForeignWorkspace("", "/Users/a/proj", {}), false);
  assert.equal(isForeignWorkspace("   ", "/Users/a/proj", {}), false);
});

test("外来工作区保护：FEISHU_ALLOW_FOREIGN_WORKSPACE=1 可显式放行", () => {
  const env = { FEISHU_ALLOW_FOREIGN_WORKSPACE: "1" };
  assert.equal(isForeignWorkspace("/Users/a/proj", "/Users/a/other", env), false);
});

test("外来工作区保护：显式 FEISHU_DATA_DIR 不会让别人的机器人变成自己的（仍拦）", () => {
  // 实例目录跟着工作区走之后，显式目录只影响落盘位置，不改变「这个机器人属于谁」——
  // 同一个 appId 被两个工作区共用会互抢连接，所以照拦。
  const env = { FEISHU_DATA_DIR: "/tmp/inst-b" };
  assert.equal(isForeignWorkspace("/Users/a/proj", "/Users/a/other", env), true);
});

test("外来工作区保护：记录里的属主是另一个目录 → 锁空闲时也判为外来", () => {
  // 本工作区 daemon 一停，锁就空了；有了属主记录，即便锁里没有 owner 也能分辨归属。
  assert.equal(isForeignWorkspace(undefined, "/Users/a/other", {}, "/Users/a/proj"), true);
  assert.equal(isForeignWorkspace(undefined, "/Users/a/proj", {}, "/Users/a/proj/"), false);
  // 锁 owner 与记录都指向本目录 → 放行
  assert.equal(isForeignWorkspace("/Users/a/proj", "/Users/a/proj", {}, "/Users/a/proj"), false);
  // 锁 owner 是别处、记录是本目录 → 仍拦截（先到先得的那一方占着锁）
  assert.equal(isForeignWorkspace("/Users/a/other", "/Users/a/proj", {}, "/Users/a/proj"), true);
  // 两个来源都没有 → 首次运行，放行
  assert.equal(isForeignWorkspace(undefined, "/Users/a/proj", {}, undefined), false);
});

test("属主工作区记录：写入后可读回，落在实例根目录，损坏/缺失都不抛错", () => {
  const tmp = mkdtempSync(join(tmpdir(), "feishu-owner-"));
  const env = { FEISHU_DATA_DIR: tmp };
  try {
    // 未写过 → undefined（不抛）
    assert.equal(readOwnerWorkspace(env), undefined);
    mkdirSync(join(tmp, "proj-a"), { recursive: true });
    writeOwnerWorkspace(join(tmp, "proj-a"), env);
    assert.equal(ownerWorkspacePath(env), join(tmp, "owner-workspace.json"));
    assert.ok(existsSync(ownerWorkspacePath(env)), "记录文件应写在实例根目录");
    assert.equal(readOwnerWorkspace(env), realpathSync(join(tmp, "proj-a")));
    // 目标目录还不存在时退回 resolve（不因 realpath 失败而拒绝写）
    writeOwnerWorkspace(join(tmp, "proj-b", "nested"), env);
    assert.equal(readOwnerWorkspace(env), join(tmp, "proj-b", "nested"));
    assert.equal(readOwnerWorkspaceAt(ownerWorkspacePath(env)), join(tmp, "proj-b", "nested"));
    // 损坏的 JSON → undefined（不抛）
    writeFileSync(ownerWorkspacePath(env), "{ 不是 json", "utf8");
    assert.equal(readOwnerWorkspace(env), undefined);
    // 空 cwd 字段 → undefined
    writeFileSync(ownerWorkspacePath(env), JSON.stringify({ cwd: "  " }), "utf8");
    assert.equal(readOwnerWorkspace(env), undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("保护：软链目录与真实目录视为同一处（realpath 归一化）", () => {
  const tmp = mkdtempSync(join(tmpdir(), "feishu-inst-"));
  try {
    const real = join(tmp, "proj");
    const other = join(tmp, "other");
    mkdirSync(real, { recursive: true });
    mkdirSync(other, { recursive: true });
    const link = join(tmp, "link");
    symlinkSync(real, link);
    // 同一目录的两种写法（真实路径 / 软链）→ 不算外来工作区
    assert.equal(isForeignWorkspace(real, link, {}), false);
    assert.ok(sameWorkspace(real, link));
    // 真的是另一个目录 → 外来
    assert.equal(isForeignWorkspace(real, other, {}), true);
    assert.ok(!sameWorkspace(real, other));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("配置落点：实例目录跟着工作区走，配置就写在工作区实例里", () => {
  // 老版本在这里做过「扫码改道」（避免覆盖全局配置）；0.6.0 没有全局实例了，
  // 落点天然就是本工作区实例目录，无需改道逻辑。
  const ws = "/Users/a/other";
  assert.equal(join(resolveRootDir({}, ws), "config.pi.json"), join(ws, ".pi", "feishu", "config.pi.json"));
});

test("搬迁后旧全局目录不存在时不会误报（没有 legacy 目录的机器）", () => {
  const home = mkdtempSync(join(tmpdir(), "feishu-home-"));
  const ws = join(home, "ws");
  mkdirSync(ws, { recursive: true });
  try {
    const { json, stderr } = probe(CONFIG_PROBE, ws, { ...process.env, HOME: home });
    assert.equal(json.root, join(realpathSync(ws), ".pi", "feishu"));
    assert.ok(!/旧全局实例目录/.test(stderr), `不该有迁移提示：${stderr}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("迁移：在子目录（如 .pi/ax-feishu-bridge）里启动不会搬走父工作区的数据", () => {
  // 严格相等：只有「就是属主目录本身」才搬。子目录里跑一次程序就搬走整份实例数据，代价太大。
  const home = mkdtempSync(join(tmpdir(), "feishu-home-"));
  const ws = join(home, "ws");
  const sub = join(ws, ".pi", "some-tool");
  const legacy = join(home, ".pi", "agent", "feishu");
  mkdirSync(legacy, { recursive: true });
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(legacy, "config.pi.json"), '{"appId":"cli_x"}\n', "utf8");
  writeFileSync(join(legacy, "owner-workspace.json"), JSON.stringify({ cwd: realpathSync(ws) }), "utf8");
  try {
    const { json, stderr } = probe(CONFIG_PROBE, sub, { ...process.env, HOME: home });
    assert.ok(existsSync(join(legacy, "config.pi.json")), "父工作区的数据必须原样留着");
    assert.ok(!existsSync(join(realpathSync(sub), ".pi", "feishu", "config.pi.json")), "子目录里不该出现搬过来的数据");
    assert.equal(json.root, join(realpathSync(sub), ".pi", "feishu"));
    assert.match(stderr, /不属于本工作区/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("迁移：测试进程里绝不搬真实数据（就算属主就是本目录）", () => {
  const home = mkdtempSync(join(tmpdir(), "feishu-home-"));
  const ws = join(home, "ws");
  const legacy = join(home, ".pi", "agent", "feishu");
  mkdirSync(legacy, { recursive: true });
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(legacy, "config.pi.json"), '{"appId":"cli_x"}\n', "utf8");
  writeFileSync(join(legacy, "owner-workspace.json"), JSON.stringify({ cwd: realpathSync(ws) }), "utf8");
  try {
    probe(CONFIG_PROBE, ws, { ...process.env, HOME: home, ALLOW_NODE_TEST_CONTEXT: "1" });
    assert.ok(existsSync(join(legacy, "config.pi.json")), "测试进程不得移动真实实例数据");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("README 提到的实例目录名与实际一致（防止文档漂移）", () => {
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  assert.match(readme, /\.pi\/feishu/, "README 应写明实例目录为 <工作区>/.pi/feishu");
});
