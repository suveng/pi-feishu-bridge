# pi-feishu-bridge 协作约定

本仓是飞书 ↔ pi 的桥接扩展包（`@suwenguang/pi-feishu-bridge`），**源码直接跑 TS，没有 dist 产物**，
`package.json` 的 `pi.extensions` 指向 `./.pi/extensions/feishu/index.ts`，pi 加载时现编现跑。

## 发布到 npm：推 `v*` 标签即自动发布

`.github/workflows/publish.yml` 的触发条件是 `on.push.tags: ["v*"]`（另有 `workflow_dispatch` 可手动跑）。
**推普通 commit 不会发布，只有推 tag 才会。** 流程为：检出 → Node 24 → 升级 npm（OIDC 发布需 ≥11.5.1）
→ `npm ci` → `npm run check`（tsc）→ `npm test` → `npm publish --provenance --access public`。
鉴权走 **npm Trusted Publisher（OIDC）**，仓库里不放 `NPM_TOKEN`，provenance 由 GitHub 签发。

### 标准三步（发版就照这个做，不要跑本地 `npm publish`）

```bash
# 1) 先改版本号，再提交（npm 不允许重发同一版本，没改号打 tag 必 409）
python3 -c "import json,pathlib;p=pathlib.Path('package.json');d=json.loads(p.read_text());d['version']='0.8.2';p.write_text(json.dumps(d,indent=2,ensure_ascii=False)+'\n')"
git commit -am "chore(release): 0.8.2" && git push origin main

# 2) 打【附注】tag 再推（--follow-tags 不推轻量 tag）
git tag -a v0.8.2 -m "v0.8.2"
HTTPS_PROXY=http://127.0.0.1:7890 git push origin HEAD --follow-tags

# 3) 等 Actions 绿，再等 registry 出现该版本（见下方「成功征兆」）
```

### 成功征兆（不看这三条就等于没验）

1. `https://github.com/suveng/pi-feishu-bridge/actions` 里 `publish v<ver>` 这次 run 为 **success**，
   且日志末行是 `+ @suwenguang/pi-feishu-bridge@<ver>`。
2. `curl -s https://registry.npmjs.org/-/package/@suwenguang%2Fpi-feishu-bridge/dist-tags` 里 `latest` 已是新版本号。
3. `curl -s -o /dev/null -w '%{http_code}' https://registry.npmjs.org/@suwenguang/pi-feishu-bridge/-/pi-feishu-bridge-<ver>.tgz`
   返回 **200**（此刻才装得上）。

### 五个坑（都实际踩过）

1. **step success ≠ 已上线**：发布后 registry 有约 3~10 分钟的复制/边缘缓存延迟，其间 `npm view` 还是老版本。
   判据是**先 `npm stage list @suwenguang/pi-feishu-bridge`** —— 返回 `No staged versions` 就说明不是「待批准」，
   只是延迟；2026-11-22 曾把延迟误判成 staged，让用户白跑了一次网页授权。
2. **别用本地 `npm publish` 顶替**：OIDC 绑定的发布只认 Actions 环境，本地跑会 403。
3. 改了 **workflow 文件名 / 仓库名 / 包名** 必须同步去 npmjs.com 的 Trusted Publisher 页面重配
   （当前：Organization=`suveng`、Repository=`pi-feishu-bridge`、Workflow filename=`publish.yml`、Environment 留空），
   否则 403。
4. **轻量 tag 推不上去**：`git push --follow-tags` 只推附注 tag，必须 `git tag -a`。
5. 发布后立刻 `npm install` 可能 404 —— 等第 3 条判据变 200 再装，不要重发。

### 装到本机（改完代码要生效）

pi 托管安装有两层目录，**看清 daemon 实际加载哪一层**再装：

- 项目级（本仓库工作区用这个）：`<工作区>/.pi/npm`，daemon 的 `-e` 参数指向
  `<工作区>/.pi/npm/node_modules/@suwenguang/pi-feishu-bridge/.pi/extensions/feishu/index.ts`
- 全局：`~/.pi/agent/npm`

```bash
# 从 registry 装（版本上线后）
cd <工作区>/.pi/npm && npm install @suwenguang/pi-feishu-bridge@<ver> --no-audit --no-fund --legacy-peer-deps
# 版本还没上线时可临时从 tag 装
cd <工作区>/.pi/npm && npm install "git+https://github.com/suveng/pi-feishu-bridge.git#v<ver>" --no-audit --no-fund --legacy-peer-deps
```

装完**必须重启桥接 daemon 才会生效**（跑着的是内存里的旧代码）：按 vkk 仓的
`.pi/skills/feishu-bridge-restart/SKILL.md`，一条命令 `bash .pi/skills/feishu-bridge-restart/restart-bridge.sh 30`
（延迟 + 脱离进程组 + 保险丝都在脚本里，别手写 kill）。
重启后判据：`.pi/feishu/restart-trace.log` 出现 `延迟结束 → SIGTERM -> <pid> → 拉起 daemon → 结果: ✅` 四段，
且 `~/.pi/agent/locks.json` 里 `ax-feishu-bridge.gateway.<appId>` 的 `status=connected`。

## 提交纪律

- 改本仓后**立刻 commit + push**（`https://github.com/suveng/pi-feishu-bridge.git`，`main`），
  收尾要给「本地 hash == 远端 hash」；不推的话别的工作区的 daemon 拿不到修复。
- 推 GitHub 必须带 `HTTPS_PROXY=http://127.0.0.1:7890`（直连会 `Failure when receiving data from the peer`）。
- 提交信息用 Conventional Commits，主题简体中文单行。

## 测试

```bash
npm run check   # tsc --noEmit
npm test        # node --experimental-strip-types --import ./test/register.mjs --test test/*.test.mjs test/*.test.ts
```

**只测纯逻辑是不够的**：卡片字段取值（如飞书输入框 `max_length` 上限 1000）只有服务端会校验，
改卡片必须补 `test/schedule-cards.test.ts` 那类「结构 + 上限」用例，并做必红自检。
