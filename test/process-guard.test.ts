/**
 * 作用域隔离测试：全局 `~/.pi/agent/npm` 与工作区 `.pi/npm` 各一份副本时，
 * 一个 Pi 进程只让其中一份初始化，且选择与加载顺序无关。
 * 对应 2026-11-21 事故（两份副本同进程互相顶锁，autoStart 拉起一个死一个）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  electExtensionLeader,
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
