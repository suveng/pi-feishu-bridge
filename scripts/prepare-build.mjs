/**
 * prepare 生命周期脚本：能构建时编译 lib/，不能则跳过。
 *
 * 背景：Pi 安装 git 包时执行 `npm install --omit=dev`，devDependencies 被裁剪，
 * typescript 不存在。若无条件 `tsc`，安装会以 code 127 失败，整个包安装中断。
 *
 * 跳过构建的两种情况：
 * 1. 未安装 typescript（--omit=dev 安装）。
 * 2. npm 的 omit 配置包含 dev（即使 node_modules 里残留 typescript）。
 *
 * Pi 侧扩展入口是 src/adapters/pi/index.ts，直接加载 TS，不依赖 lib/。
 * 本地开发 / npm publish 时依赖齐全，会正常编译出 lib/。
 */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);

function skip(reason) {
  console.log(`[ax-feishu-bridge] 跳过构建 lib/：${reason}`);
  process.exit(0);
}

const omitted = (process.env.npm_config_omit ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (omitted.includes("dev")) {
  skip(`npm omit=${omitted.join(",")}，devDependencies 不可用`);
}

let tscBin;
try {
  tscBin = require.resolve("typescript/bin/tsc");
} catch {
  skip("未安装 typescript。Pi 扩展直接加载 src/*.ts，无需 lib/");
}

const result = spawnSync(process.execPath, [tscBin, "-p", "tsconfig.build.json"], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
