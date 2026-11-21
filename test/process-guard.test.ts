/**
 * 作用域隔离测试：全局 `~/.pi/agent/npm` 与工作区 `.pi/npm` 各一份副本时，
 * 一个 Pi 进程只让其中一份初始化，且选择与加载顺序无关。
 * 对应 2026-11-21 事故（两份副本同进程互相顶锁，autoStart 拉起一个死一个）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  electExtensionLeader,
  explicitExtensionEntries,
  isWorkspaceCopyActive,
  readCopyVersion,
  releaseProcessSlotForTest,
  resolveExtensionScope,
  workspaceCopyEntry,
} from "../src/feishu/process-guard.ts";

const CWD = "/repo/work";
const GLOBAL_ENTRY = "/Users/me/.pi/agent/npm/node_modules/@suwenguang/pi-feishu-bridge/.pi/extensions/feishu/index.ts";
const WORKSPACE_ENTRY = workspaceCopyEntry(CWD);

const versions = (map: Record<string, string>) => (entry: string) => map[entry];

test("作用域：入口落在 <cwd>/.pi/ 下算工作区副本，其余算全局", () => {
  assert.equal(resolveExtensionScope(WORKSPACE_ENTRY, CWD), "workspace");
  assert.equal(resolveExtensionScope(GLOBAL_ENTRY, CWD), "global");
  // 别的工作区目录下的副本，对当前 cwd 来说不是「本工作区的副本」
  assert.equal(resolveExtensionScope("/other/.pi/npm/x/index.ts", CWD), "global");
});

test("隔离：工作区有声明时，全局副本让位（即使它先加载）", () => {
  releaseProcessSlotForTest();
  try {
    const shared = {
      cwd: CWD,
      isWorkspaceCopyActive: () => true,
      readVersion: versions({ [GLOBAL_ENTRY]: "0.6.8", [WORKSPACE_ENTRY]: "0.6.8" }),
    };
    const globalElection = electExtensionLeader(GLOBAL_ENTRY, shared);
    assert.deepEqual(
      { leader: globalElection.leader, reason: globalElection.leader ? "" : globalElection.reason },
      { leader: false, reason: "workspace-copy-preferred" },
    );

    const workspaceElection = electExtensionLeader(WORKSPACE_ENTRY, shared);
    assert.equal(workspaceElection.leader, true);
    if (workspaceElection.leader) assert.equal(workspaceElection.reason, "workspace-copy");
  } finally {
    releaseProcessSlotForTest();
  }
});

test("隔离：工作区副本先加载时，全局副本被判为已初始化并不再接管", () => {
  releaseProcessSlotForTest();
  try {
    const shared = {
      cwd: CWD,
      isWorkspaceCopyActive: () => true,
      readVersion: versions({ [GLOBAL_ENTRY]: "0.6.8", [WORKSPACE_ENTRY]: "0.6.8" }),
    };
    assert.equal(electExtensionLeader(WORKSPACE_ENTRY, shared).leader, true);
    const globalElection = electExtensionLeader(GLOBAL_ENTRY, shared);
    assert.equal(globalElection.leader, false);
    if (!globalElection.leader) assert.equal(globalElection.reason, "workspace-copy-preferred");
  } finally {
    releaseProcessSlotForTest();
  }
});

test("隔离：工作区没声明这份插件时，全局副本兜底生效", () => {
  releaseProcessSlotForTest();
  try {
    const election = electExtensionLeader(GLOBAL_ENTRY, {
      cwd: CWD,
      isWorkspaceCopyActive: () => false,
      readVersion: () => "0.6.8",
    });
    assert.equal(election.leader, true);
    if (election.leader) assert.equal(election.reason, "global-only");
  } finally {
    releaseProcessSlotForTest();
  }
});

test("隔离：工作区副本版本更旧时，全局副本生效（不在工作区里跑老代码）", () => {
  releaseProcessSlotForTest();
  try {
    const shared = {
      cwd: CWD,
      isWorkspaceCopyActive: () => true,
      readVersion: versions({ [GLOBAL_ENTRY]: "0.6.8", [WORKSPACE_ENTRY]: "0.6.6" }),
    };
    const globalElection = electExtensionLeader(GLOBAL_ENTRY, shared);
    assert.equal(globalElection.leader, true);
    if (globalElection.leader) assert.equal(globalElection.reason, "workspace-copy-outdated");

    const workspaceElection = electExtensionLeader(WORKSPACE_ENTRY, shared);
    assert.equal(workspaceElection.leader, false);
    if (!workspaceElection.leader) assert.equal(workspaceElection.reason, "already-initialized");
  } finally {
    releaseProcessSlotForTest();
  }
});

test("隔离：同一作用域重复加载，第二份让位给先到者", () => {
  releaseProcessSlotForTest();
  try {
    const shared = { cwd: CWD, isWorkspaceCopyActive: () => false, readVersion: () => "0.6.8" };
    assert.equal(electExtensionLeader(GLOBAL_ENTRY, shared).leader, true);
    const second = electExtensionLeader("/opt/other/.pi/agent/npm/x/index.ts", shared);
    assert.equal(second.leader, false);
    if (!second.leader) {
      assert.equal(second.reason, "already-initialized");
      assert.equal(second.activeEntry, GLOBAL_ENTRY);
    }
  } finally {
    releaseProcessSlotForTest();
  }
});

test("隔离：清位后可以重新占位（用例隔离，避免污染）", () => {
  releaseProcessSlotForTest();
  try {
    const shared = { cwd: CWD, isWorkspaceCopyActive: () => false, readVersion: () => "0.6.8" };
    assert.equal(electExtensionLeader(GLOBAL_ENTRY, shared).leader, true);
    releaseProcessSlotForTest();
    assert.equal(electExtensionLeader(GLOBAL_ENTRY, shared).leader, true);
  } finally {
    releaseProcessSlotForTest();
  }
});

test("磁盘判定：工作区未声明插件时 isWorkspaceCopyActive 为假，版本读取失败不应抛错", () => {
  assert.equal(isWorkspaceCopyActive("/definitely/not/a/repo"), false);
  assert.equal(readCopyVersion("/definitely/not/a/repo/.pi/extensions/feishu/index.ts"), undefined);
});

test("显式入口：从 argv 里解析 -e / --extension 的值", () => {
  assert.deepEqual(
    explicitExtensionEntries([
      "pi", "--mode", "rpc", "--no-extensions",
      "-e", "/a/bridge/.pi/extensions/feishu/index.ts",
      "-e", "/repo/.pi/extensions/slow-tool-log/index.ts",
      "--extension=/c/bridge/.pi/extensions/feishu/index.ts",
      "--extension", "-not-a-path",
    ]),
    [
      "/a/bridge/.pi/extensions/feishu/index.ts",
      "/repo/.pi/extensions/slow-tool-log/index.ts",
      "/c/bridge/.pi/extensions/feishu/index.ts",
    ],
  );
});

test("显式入口：daemon 只带全局入口时，全局副本必须生效（不再让位给没被加载的工作区副本）", () => {
  releaseProcessSlotForTest();
  // 2026-11-21 的真实翻车：daemon 用 -e 全局入口启动、工作区又装了副本，
  // 若按「工作区优先」判，全局让位而工作区没加载 → 谁都不跑，飞书断线。
  const shared = {
    cwd: CWD,
    argv: ["pi", "--mode", "rpc", "-e", GLOBAL_ENTRY],
    isWorkspaceCopyActive: () => true,
    readVersion: versions({ [GLOBAL_ENTRY]: "0.6.8", [WORKSPACE_ENTRY]: "0.6.8" }),
  };
  try {
    const election = electExtensionLeader(GLOBAL_ENTRY, shared);
    assert.equal(election.leader, true);
    assert.equal(election.reason, "explicit-single");
  } finally {
    releaseProcessSlotForTest();
  }
});

test("显式入口：argv 同时列了两份时按顺序取第一份，其余让位", () => {
  releaseProcessSlotForTest();
  const both = {
    cwd: CWD,
    argv: ["pi", "--mode", "rpc", "-e", WORKSPACE_ENTRY, "-e", GLOBAL_ENTRY],
    isWorkspaceCopyActive: () => true,
    readVersion: versions({ [GLOBAL_ENTRY]: "0.6.8", [WORKSPACE_ENTRY]: "0.6.8" }),
  };
  try {
    assert.equal(electExtensionLeader(WORKSPACE_ENTRY, both).leader, true);
    const deferred = electExtensionLeader(GLOBAL_ENTRY, both);
    assert.equal(deferred.leader, false);
    assert.equal(deferred.reason, "explicit-order");
    assert.equal("activeEntry" in deferred ? deferred.activeEntry : undefined, WORKSPACE_ENTRY);
  } finally {
    releaseProcessSlotForTest();
  }
});

test("显式入口：argv 里只有别的插件入口时，桥接仍按自身是否在列表里判定", () => {
  releaseProcessSlotForTest();
  const other = {
    cwd: CWD,
    argv: ["pi", "--mode", "rpc", "-e", "/repo/.pi/extensions/slow-tool-log/index.ts"],
    isWorkspaceCopyActive: () => true,
    readVersion: versions({ [GLOBAL_ENTRY]: "0.6.8", [WORKSPACE_ENTRY]: "0.6.8" }),
  };
  try {
    // 桥接不在显式列表里 → 退回包加载模式，工作区副本优先
    assert.equal(electExtensionLeader(GLOBAL_ENTRY, other).leader, false);
    assert.equal(electExtensionLeader(WORKSPACE_ENTRY, other).leader, true);
  } finally {
    releaseProcessSlotForTest();
  }
});
