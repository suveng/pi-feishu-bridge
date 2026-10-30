import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_INSTANCE_NAME,
  instanceConfigPath,
  instanceDirForName,
  instanceNameFromDir,
  isValidInstanceName,
  listInstances,
  readInstanceAppId,
  readInstanceConfig,
} from "../src/feishu/instances.ts";

function tempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "feishu-instances-"));
  mkdirSync(join(root, ".pi"), { recursive: true });
  return root;
}

function writeConfig(dir: string, data: Record<string, unknown>) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(instanceConfigPath(dir), JSON.stringify(data), "utf8");
}

test("TC-INST-NAME-01 合法实例名：小写字母/数字/连字符", () => {
  assert.equal(isValidInstanceName("duocheck"), true);
  assert.equal(isValidInstanceName("b"), true);
  assert.equal(isValidInstanceName("bot-2"), true);
});

test("TC-INST-NAME-02 非法实例名：大写/下划线/前导连字符/保留名/超长", () => {
  assert.equal(isValidInstanceName("DuoCheck"), false);
  assert.equal(isValidInstanceName("bot_2"), false);
  assert.equal(isValidInstanceName("-bot"), false);
  assert.equal(isValidInstanceName(""), false);
  assert.equal(isValidInstanceName(DEFAULT_INSTANCE_NAME), false);
  assert.equal(isValidInstanceName("config"), false);
  assert.equal(isValidInstanceName("a".repeat(32)), false);
});

test("TC-INST-DIR-01 实例名 ↔ 目录：default 是 .pi/feishu，其余是 .pi/feishu-<name>", () => {
  const root = tempWorkspace();
  try {
    assert.equal(instanceDirForName(root, "default"), join(root, ".pi", "feishu"));
    assert.equal(instanceDirForName(root), join(root, ".pi", "feishu"));
    assert.equal(instanceDirForName(root, "duocheck"), join(root, ".pi", "feishu-duocheck"));

    assert.equal(instanceNameFromDir(root, join(root, ".pi", "feishu")), "default");
    assert.equal(instanceNameFromDir(root, join(root, ".pi", "feishu-duocheck")), "duocheck");
    // 不在 .pi 下 / 前缀不符 / 名字非法 → undefined
    assert.equal(instanceNameFromDir(root, join(root, "feishu-x")), undefined);
    assert.equal(instanceNameFromDir(root, join(root, ".pi", "other")), undefined);
    assert.equal(instanceNameFromDir(root, join(root, ".pi", "feishu-Bad")), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TC-INST-CFG-01 readInstanceConfig：缺文件/坏 JSON/缺 appSecret 都返回 undefined", () => {
  const root = tempWorkspace();
  try {
    const dir = instanceDirForName(root, "bot-a");
    assert.equal(readInstanceConfig(dir), undefined);

    mkdirSync(dir, { recursive: true });
    writeFileSync(instanceConfigPath(dir), "{not json", "utf8");
    assert.equal(readInstanceConfig(dir), undefined);

    writeConfig(dir, { appId: "cli_x" });
    assert.equal(readInstanceConfig(dir), undefined);

    writeConfig(dir, { appId: " cli_x ", appSecret: " s ", domain: "lark" });
    const cfg = readInstanceConfig(dir);
    assert.equal(cfg?.appId, "cli_x");
    assert.equal(cfg?.appSecret, "s");
    assert.equal(cfg?.domain, "lark");
    assert.equal(readInstanceAppId(dir), "cli_x");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TC-INST-LIST-01 listInstances：默认实例排首位，未配置目录也算实例，非 feishu- 目录不算", () => {
  const root = tempWorkspace();
  try {
    writeConfig(instanceDirForName(root, "default"), { appId: "cli_default", appSecret: "s" });
    writeConfig(instanceDirForName(root, "zbot"), { appId: "cli_z", appSecret: "s" });
    mkdirSync(instanceDirForName(root, "abot"), { recursive: true }); // 有目录没配置
    mkdirSync(join(root, ".pi", "feishu-debug"), { recursive: true }); // 保留名，不算实例
    mkdirSync(join(root, ".pi", "unrelated"), { recursive: true });

    const names = listInstances(root).map((instance) => instance.name);
    assert.deepEqual(names, ["default", "abot", "zbot"]);

    const abot = listInstances(root).find((instance) => instance.name === "abot");
    assert.equal(abot?.configured, false);

    const zbot = listInstances(root).find((instance) => instance.name === "zbot");
    assert.equal(zbot?.configured, true);
    assert.equal(zbot?.appId, "cli_z");
    assert.equal(zbot?.autoStart, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TC-INST-LIST-02 空工作区不列出未建目录的 default", () => {
  const root = tempWorkspace();
  try {
    assert.deepEqual(listInstances(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
