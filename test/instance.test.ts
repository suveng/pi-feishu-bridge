import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ROOT_DIR,
  instanceWebhookPort,
  isForeignWorkspace,
  ownerWorkspacePath,
  readOwnerWorkspace,
  writeOwnerWorkspace,
  resolveHarnessRoot,
  resolveInstanceDir,
  resolveRootDir,
  workspaceInstanceDir,
} from "../src/feishu/instance.ts";
import { resolveConfigWriteTarget } from "../src/feishu/config.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("未设 FEISHU_DATA_DIR 时按主实例处理（向后兼容）", () => {
  const env = {};
  assert.equal(resolveInstanceDir(env), undefined);
  assert.equal(resolveRootDir(env), DEFAULT_ROOT_DIR);
  assert.equal(resolveHarnessRoot("/dsh/feishu", env), "/dsh/feishu");
});

test("FEISHU_DATA_DIR 为空串或纯空白等同于未设", () => {
  assert.equal(resolveInstanceDir({ FEISHU_DATA_DIR: "" }), undefined);
  assert.equal(resolveInstanceDir({ FEISHU_DATA_DIR: "   " }), undefined);
});

test("FEISHU_DATA_DIR 生效时根目录跟随，Harness 挪到实例目录下的 harness/", () => {
  const dir = "/tmp/feishu-inst-a";
  const env = { FEISHU_DATA_DIR: dir };
  assert.equal(resolveInstanceDir(env), dir);
  assert.equal(resolveRootDir(env), dir);
  assert.equal(resolveHarnessRoot("/dsh/feishu", env), join(dir, "harness"));
});

test("FEISHU_DATA_DIR 支持 ~ 展开与相对路径转绝对路径", () => {
  assert.equal(resolveInstanceDir({ FEISHU_DATA_DIR: "~" }), homedir());
  assert.equal(resolveInstanceDir({ FEISHU_DATA_DIR: "~/feishu-b" }), join(homedir(), "feishu-b"));
  const rel = resolveInstanceDir({ FEISHU_DATA_DIR: "feishu-c" });
  assert.ok(rel && rel.startsWith("/"), `相对路径应转为绝对路径，实际 ${rel}`);
});

test("端口：主实例沿用 3001/3002，多实例派生到 3003-3099", () => {
  assert.equal(instanceWebhookPort(3001, {}), 3001);
  assert.equal(instanceWebhookPort(3002, {}), 3002);

  const derived = instanceWebhookPort(3001, { FEISHU_DATA_DIR: "/tmp/feishu-inst-a" });
  assert.ok(derived >= 3003 && derived <= 3099, `派生端口应在 3003-3099，实际 ${derived}`);
});

test("端口：同一实例目录稳定、不同目录互不相同、Pi 与 DSH 不撞端口", () => {
  const a = { FEISHU_DATA_DIR: "/tmp/feishu-inst-a" };
  // 同一目录重复调用必须稳定（飞书后台的回调地址只需配一次）
  assert.equal(instanceWebhookPort(3001, a), instanceWebhookPort(3001, a));
  // 同一目录下 Pi 与 DSH 的 base 不同，端口也不应相同
  assert.notEqual(instanceWebhookPort(3001, a), instanceWebhookPort(3002, a));

  const ports = new Set<number>();
  const bases = new Set<number>();
  for (let i = 0; i < 12; i += 1) {
    const env = { FEISHU_DATA_DIR: `/tmp/feishu-inst-${i}` };
    ports.add(instanceWebhookPort(3001, env));
    bases.add(instanceWebhookPort(3001, env));
  }
  assert.ok(ports.size > 1, "12 个不同实例目录不应全部落到同一个端口");
  assert.deepEqual([...ports].sort(), [...bases].sort());
});

test("端到端：设了 FEISHU_DATA_DIR 后 config.ts 的落盘路径整体迁移", () => {
  const instanceDir = join(REPO_ROOT, "test", "fixtures", "instance-dir-probe");
  const script = [
    "import * as cfg from './src/feishu/config.ts';",
    "console.log(JSON.stringify({",
    "  root: cfg.ROOT_DIR,",
    "  state: cfg.STATE_PI_PATH,",
    "  config: cfg.CONFIG_PI_PATH,",
    "  daemonLog: cfg.DAEMON_LOG_PATH,",
    "  harnessRoot: cfg.HARNESS_ROOT,",
    "  port: cfg.defaultCardActionWebhookPort(),",
    "}));",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "-e", script], {
    cwd: REPO_ROOT,
    env: { ...process.env, FEISHU_DATA_DIR: instanceDir, DSH_HOME: "/tmp/dsh-probe" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `子进程应正常退出：${result.stderr}`);
  const out = JSON.parse(result.stdout.trim());
  assert.equal(out.root, instanceDir);
  assert.equal(out.state, join(instanceDir, "state.pi.json"));
  assert.equal(out.config, join(instanceDir, "config.pi.json"));
  assert.equal(out.daemonLog, join(instanceDir, "daemon.log"));
  assert.equal(out.harnessRoot, join(instanceDir, "harness"));
  assert.ok(out.port >= 3003 && out.port <= 3099, `多实例端口应在 3003-3099，实际 ${out.port}`);
});

test("裸开保护：未隔离 + 锁 owner 属于另一个目录 → 判为外来工作区", () => {
  assert.equal(isForeignWorkspace("/Users/a/proj", "/Users/a/other", {}), true);
});

test("裸开保护：owner 就是本目录（含尾斜杠差异）→ 不算外来", () => {
  assert.equal(isForeignWorkspace("/Users/a/proj", "/Users/a/proj", {}), false);
  assert.equal(isForeignWorkspace("/Users/a/proj/", "/Users/a/proj", {}), false);
});

test("裸开保护：没有 owner（本机从未起过 daemon）→ 放行", () => {
  assert.equal(isForeignWorkspace(undefined, "/Users/a/proj", {}), false);
  assert.equal(isForeignWorkspace("", "/Users/a/proj", {}), false);
  assert.equal(isForeignWorkspace("   ", "/Users/a/proj", {}), false);
});

test("裸开保护：已做实例隔离时不适用（各用各的）", () => {
  const env = { FEISHU_DATA_DIR: "/tmp/inst-b" };
  assert.equal(isForeignWorkspace("/Users/a/proj", "/Users/a/other", env), false);
});

test("裸开保护：FEISHU_ALLOW_FOREIGN_WORKSPACE=1 可显式放行", () => {
  const env = { FEISHU_ALLOW_FOREIGN_WORKSPACE: "1" };
  assert.equal(isForeignWorkspace("/Users/a/proj", "/Users/a/other", env), false);
});

test("裸开保护：记录里的属主是另一个目录 → 锁空闲时也判为外来（0.5.2 新增）", () => {
  // 上一版的漏洞：本工作区 daemon 一停，锁就空了，别的目录裸开就会把连接接走；
  // 有了属主记录，即便锁里没有 owner 也能分辨出这份配置属于谁。
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

test("扫码改道：属主在别处 → 凭证写本目录实例，不碰全局（0.5.3）", () => {
  const other = "/Users/a/proj";
  const mine = "/Users/a/other";
  // 判定：本目录实例目录
  assert.equal(workspaceInstanceDir(mine, {}, other), join(mine, ".pi", "feishu"));
  // 落点：本目录实例的 config.pi.json + 带 redirectedDir（调用方据此提示用启动器）
  const target = resolveConfigWriteTarget(mine, {}, other);
  assert.equal(target.path, join(mine, ".pi", "feishu", "config.pi.json"));
  assert.equal(target.redirectedDir, join(mine, ".pi", "feishu"));
  // 主工作区自己 / 已隔离 / 显式放行 → 都不改道，仍写全局
  assert.equal(resolveConfigWriteTarget("/Users/a/proj", {}, "/Users/a/proj").path, join(DEFAULT_ROOT_DIR, "config.pi.json"));
  assert.equal(resolveConfigWriteTarget(mine, { FEISHU_DATA_DIR: "/tmp/inst-b" }, other).path, join(DEFAULT_ROOT_DIR, "config.pi.json"));
  assert.equal(resolveConfigWriteTarget(mine, { FEISHU_ALLOW_FOREIGN_WORKSPACE: "1" }, other).path, join(DEFAULT_ROOT_DIR, "config.pi.json"));
});

test("扫码改道：没有属主记录但本目录已有 .pi/feishu → 也改道", () => {
  const tmp = mkdtempSync(join(tmpdir(), "feishu-redirect-"));
  const base = realpathSync(tmp); // macOS 的 /var 是 /private/var 的软链，比较前先归一化
  try {
    assert.equal(workspaceInstanceDir(tmp, {}, undefined), undefined, "没有实例目录时照常写全局");
    mkdirSync(join(tmp, ".pi", "feishu"), { recursive: true });
    assert.equal(workspaceInstanceDir(tmp, {}, undefined), join(base, ".pi", "feishu"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("裸开保护：软链目录与真实目录视为同一处（realpath 归一化）", () => {
  const tmp = mkdtempSync(join(tmpdir(), "feishu-inst-"));
  try {
    const real = join(tmp, "proj");
    mkdirSync(real, { recursive: true });
    const link = join(tmp, "link");
    symlinkSync(real, link);
    // 同一目录的两种写法（真实路径 / 软链）→ 不算外来工作区
    assert.equal(isForeignWorkspace(real, link, {}), false);
    // 真的是另一个目录 → 外来
    assert.equal(isForeignWorkspace(real, tmp, {}), true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
