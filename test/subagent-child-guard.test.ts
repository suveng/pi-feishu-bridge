/**
 * pi-subagents 子进程守卫（2026-11-26 派发故障回归）：
 *
 * 飞书 daemon 会话里派发子 agent 时，子进程继承 PI_FEISHU_DAEMON=1；
 * 桥接扩展在子进程加载时若走 daemon 自启分支，会抢单例失败后 process.exit(0)，
 * 把整个子会话打死（评审等子任务根本没跑，表现为「启动即失败、日志空白」）。
 *
 * 守卫要求：PI_SUBAGENT_CHILD=1（pi-subagents 给子进程打的标记）时，
 * 扩展入口清掉继承的 PI_FEISHU_DAEMON 并直接返回——既不当 daemon，也不 spawn daemon。
 *
 * 用子进程探针验证（真 import 扩展入口，隔离 HOME/FEISHU_DATA_DIR，不碰本机真实锁）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const PROBE = `
import createPiFeishuExtension from "./src/adapters/pi/index.ts";
// 守卫在任何 pi API 使用前返回，空 stub 即可；若守卫失效，daemon 分支会抢锁/exit。
createPiFeishuExtension({}, {});
console.log(JSON.stringify({
  alive: true,
  daemonFlag: process.env.PI_FEISHU_DAEMON ?? null,
}));
`;

test("PI_SUBAGENT_CHILD=1 时扩展入口清掉继承的 daemon flag 并直接返回", () => {
  const home = mkdtempSync(join(tmpdir(), "feishu-child-guard-"));
  try {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", PROBE],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HOME: home,
          FEISHU_DATA_DIR: join(home, "inst"),
          PI_SUBAGENT_CHILD: "1",
          PI_FEISHU_DAEMON: "1",
        },
        encoding: "utf8",
        timeout: 30000,
      },
    );
    assert.equal(result.status, 0, `探针应活着退出，stderr: ${result.stderr}`);
    const report = JSON.parse(result.stdout.trim().split("\n").pop()!);
    assert.equal(report.alive, true);
    assert.equal(report.daemonFlag, null, "继承的 PI_FEISHU_DAEMON 必须被清掉");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
