import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_SOURCE, loadBaseConfig, setRuntimeSource } from "../src/feishu/config.ts";

/** 在临时实例目录里写一份 config.pi.json，并让配置读取指向它 */
function withConfig(raw: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "feishu-cfg-"));
  const configPath = join(dir, "config.pi.json");
  writeFileSync(configPath, JSON.stringify({ appId: "cli_test", appSecret: "s", ...raw }));
  setRuntimeSource({ ...PI_SOURCE, configPath });
  return loadBaseConfig();
}

test("TC-BRIDGE-PROGRESS-01 config.pi.json 的 progressMode 会被读取（此前被静默忽略）", () => {
  try {
    assert.equal(withConfig({ progressMode: "off" })?.progressMode, "off");
  } finally {
    setRuntimeSource(PI_SOURCE);
  }
});

test("TC-BRIDGE-PROGRESS-02 大小写与空白容错", () => {
  try {
    assert.equal(withConfig({ progressMode: "  OFF " })?.progressMode, "off");
  } finally {
    setRuntimeSource(PI_SOURCE);
  }
});

test("TC-BRIDGE-PROGRESS-03 非法档位当作未设，回落默认", () => {
  try {
    assert.equal(withConfig({ progressMode: "noisy" })?.progressMode, undefined);
  } finally {
    setRuntimeSource(PI_SOURCE);
  }
});

test("TC-BRIDGE-PROGRESS-04 行数上限与超时秒数一并读取", () => {
  try {
    const cfg = withConfig({ progressMode: "action", progressMaxLines: 12, progressTimeoutSeconds: 45 });
    assert.equal(cfg?.progressMaxLines, 12);
    assert.equal(cfg?.progressTimeoutSeconds, 45);
  } finally {
    setRuntimeSource(PI_SOURCE);
  }
});
