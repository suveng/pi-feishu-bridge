import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ROOT_DIR,
  instanceWebhookPort,
  resolveHarnessRoot,
  resolveInstanceDir,
  resolveRootDir,
} from "../src/feishu/instance.ts";

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
