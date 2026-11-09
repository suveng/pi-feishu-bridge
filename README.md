# pi-feishu-bridge

## 主要能力

- 通过扫码快速创建飞书/Lark 机器人，减少手动配置
- 支持私聊、群聊、群话题分别维护独立的 Pi 会话
- 支持群聊策略：
  - `open`：群里和话题里可直接回复，不需要 @，还需手动在飞书开发者后台开启机器人“**获取群组中所有消息**”的权限
  - `mention`：只有 `@` 机器人、命中关键词或回复机器人消息时才会回复（后两项可选开启）
- 支持图片、代码文件和文本文件等附件输入；图片识别取决于当前模型是否支持图片
- 支持压缩包（.zip）附件：下载到本地收件箱（`<工作区>/.pi/feishu/inbox/<消息ID>/`）并把路径写进 prompt，由 agent 自行解压读取，避免大日志包被上下文截断
- 支持解析飞书 interactive 告警卡片；回复一条消息或卡片时，可把原内容一并带给 Pi
- 支持群聊关键词触发、回复机器人消息继续追问
- 支持在飞书内切换当前会话的模型、工作区、历史会话和思考强度
- 收到消息后立即显示“正在回复…”，后续答案在同一张卡片中流式输出；可停止，并会显示完成或失败状态
- 支持渲染显示 Markdown 格式内容
- Pi agent 关闭后，仍有后台常驻服务可以对话，pi agent 无需前台运行

## 快速开始

#### 1. 安装

```bash
pi install npm:@suwenguang/pi-feishu-bridge
```

> npm 包名是 `@suwenguang/pi-feishu-bridge`（仓库名 `pi-feishu-bridge`），发布由 GitHub Actions 走 OIDC 信任发布，不用 token。
> 历史上 npm 上的 `ax-feishu-bridge` 是上游原作者（AX1202）的包，本仓是它的分支，不含那份的代码更新。

也可以从 Git 安装：

```bash
pi install git:github.com/suveng/pi-feishu-bridge
pi install git:gitee.com/suveng/pi-feishu-bridge   # 国内更快
```

#### 2. 初始化配置

在 Pi 里运行 `/feishu setup`，推荐选择“扫码自动创建飞书助手”，按提示扫描终端里的二维码即可。
如果已有现成的飞书/Lark 应用，也可以选择手动填写 App ID 和 App Secret。

#### 3. 启动桥接

```bash
/feishu start
```

开了自动启动后，Pi 会话启动时会自动连上飞书/Lark。

#### 4. 开始聊天

在飞书/Lark 里打开机器人直接发消息：私聊直接发；群聊按群聊策略决定是否需要 `@`；每个群话题独立对应一个 Pi 会话。

> 群聊策略设为 `open` 后，想不 @ 机器人就回复群内任何消息，还需到飞书开发者后台 - 对应机器人事件与回调 - 打开“获取群组中所有消息”或“获取群组中用户和机器人发送的消息”任意一个权限。

## 飞书里怎么用

| 命令       | 作用                   |
| -------- | -------------------- |
| `/new`   | 为当前会话新建一个 Pi 会话      |
| `/resume` | 打开当前工作区的历史会话列表；可在卡片中切到全部会话 |
| `/model` | 打开模型选择卡片，切换当前会话使用的模型 |
| `/thinking` | 打开思考强度选择卡片，切换当前模型实际支持的档位 |
| `/stop`  | 停止当前这条回复的处理          |
| `/workspace` | 查看当前会话绑定的工作区      |
| `/workspace /path/to/project` | 把当前会话切换到指定工作区，下一条消息生效 |
| `/status` | 查看当前会话的工作状态、模型、思考强度和上下文占用 |
| `/commands` | 查看机器人支持的全部命令 |
| `/config` | 查看运行时配置（仅限与机器人的私聊） |
| `/config groupKeywords 关键词1,关键词2` | 设置群聊关键词触发并立即生效 |
| `/config streamingReply false` | 关闭流式展示，改用普通回复卡片 |
| `/config clear groupKeywords` | 清除某项运行时配置覆盖 |
| `/restart` | 重启桥接进程并加载最新代码/配置，**会话上下文保留**（仅私聊；卡片原地变成「已重启」） |
| `/restart force` | 有回复正在生成时强制中止并重启 |

## Pi 里怎么管理

| 命令                  | 作用                  |
| ------------------- | ------------------- |
| `/feishu setup`     | 打开初始化配置             |
| `/feishu start`     | 启动飞书桥接              |
| `/feishu stop`      | 停止飞书桥接              |
| `/feishu restart`   | 重启桥接，并重新加载最新代码和配置   |
| `/feishu status`    | 查看连接状态、当前 owner 和配置 |
| `/feishu autostart` | 开关自动启动              |
| `/feishu debug`     | 查看最近 20 条调试日志       |
| `/feishu reset`     | 清除配置和映射，但保留会话历史     |

## 配置

配置默认保存在 `<工作区>/.pi/feishu/config.json`。实例目录默认跟着工作区走（0.6.0 起），机器上不再有全局实例；设 `FEISHU_DATA_DIR` 可显式改到别处。若旧版留下的全局 `~/.pi/agent/feishu` 确实属于本工作区，桥接会在首次启动时把它整份搬进本工作区实例目录，并在日志里说明。

### 环境变量

| 变量                    | 说明                            |
| --------------------- | ----------------------------- |
| `FEISHU_DATA_DIR`     | 实例数据目录；默认跟着工作区走 = `<工作区>/.pi/feishu`（一般不用设），设了则整体改用该目录 |
| `FEISHU_ALLOW_FOREIGN_WORKSPACE` | 设为 `1` 时跳过「裸开保护」（见下方「同一台机器多开」）；仅在确需临时接管另一个工作区的机器人时用 |
| `FEISHU_APP_ID`       | 飞书/Lark 应用 ID                 |
| `FEISHU_APP_SECRET`   | 飞书/Lark 应用密钥                  |
| `FEISHU_DOMAIN`       | `feishu` 或 `lark`，默认 `feishu` |
| `FEISHU_GROUP_POLICY` | `open` 或 `mention`，默认 `open`  |
| `FEISHU_GROUP_KEYWORDS` | 群聊关键词，逗号或分号分隔；命中后无需 @ |
| `FEISHU_GROUP_ALSO_ON_REPLY` | `1` 时回复机器人消息可继续追问，无需再次 @ |
| `FEISHU_IGNORE_BOT_MESSAGES` | 是否忽略其他机器人消息，默认 `true` |
| `FEISHU_LANGUAGE`     | `zh` 或 `en`                   |
| `FEISHU_REACT_EMOJI`  | 收到消息时的表情回应，默认 `Get`      |
| `FEISHU_AUTO_START`   | `1` 或 `0`                     |
| `FEISHU_CARD_ACTION_MODE` | `webhook` 或 `ws`，默认 `webhook` |
| `FEISHU_CARD_ACTION_WEBHOOK_HOST` | 卡片回调监听地址，默认 `0.0.0.0` |
| `FEISHU_CARD_ACTION_WEBHOOK_PORT` | 卡片回调端口，按实例目录派生（稳定落在 `3003-3099`）；显式设置时优先 |
| `FEISHU_CARD_ACTION_WEBHOOK_PATH` | 卡片回调路径，默认 `/webhook/card` |
| `FEISHU_PROMPT_NOTIFY_SEC` | 长任务超过多少秒后在飞书发一条“仍在处理中”提示，默认 `180`，`0` 关闭 |
| `FEISHU_PROMPT_TIMEOUT_SEC` | 任务硬超时秒数，超时后中止任务并报失败，默认 `0`（不设硬超时） |
| `FEISHU_PARSE_INTERACTIVE_CARDS` | 是否把 interactive 卡片转为 Pi 可读文字，默认 `true` |
| `FEISHU_INCLUDE_QUOTED_MESSAGE` | 回复/引用消息时是否带入原消息内容，默认 `true` |
| `FEISHU_QUOTED_MESSAGE_MAX_CHARS` | 引用消息最多带入的字符数，默认 `8000` |
| `FEISHU_SEND_MAX_RETRIES` | 飞书接口临时失败时的重试次数，默认 `2` |
| `FEISHU_STREAMING_REPLY` | 是否启用 CardKit 单卡流式回复，默认 `true` |
| `FEISHU_STREAM_PRINT_FREQUENCY_MS` | 流式逐字显示的刷新间隔，默认 `50` |
| `FEISHU_STREAM_PRINT_STEP` | 每次显示的字符数，默认 `1` |
| `FEISHU_STREAM_PUSH_INTERVAL_MS` | 向飞书推送最新正文的间隔，默认 `120` 毫秒 |
| `FEISHU_EXT_DEV`      | `1` 时显示本地开发标识 `DEV`           |

### config.json 字段

也可以写进 `config.json`（优先级：环境变量 > config.json > 默认值）：

| 字段                   | 说明                            |
| --------------------- | ----------------------------- |
| `promptNotifySec`     | 长任务超过多少秒后在飞书发一条“仍在处理中”提示，默认 `180`，`0` 关闭 |
| `promptTimeoutSec`    | 任务硬超时秒数，超时后中止任务并报失败，默认 `0` |

长任务（跑测试、构建、批量处理）默认**不会**被报为“任务失败”：到达 `promptNotifySec` 只提示“任务仍在处理中”，卡片保持“回复中”，完成后正常送达。只有显式设 `promptTimeoutSec` 才硬超时。修改后执行 `/feishu restart` 生效。

等用户作答（`feishu_ask` 选择题）的时间**不计入**硬超时，选择题本身**不设自动超时**：卡片一直停在「等待选择」，直到用户点选/自由输入，或被停止按钮、新消息打断。建议把 `promptTimeoutSec` 设为 `0`，便于一眼看出实际耗时口径。

### 运行时配置

以下设置可在**与机器人的私聊**里用 `/config` 立即修改，无需重启，并保存到 `<工作区>/.pi/feishu/runtime-overrides.json`：

```text
/config
/config groupKeywords 报警,告警
/config groupAlsoOnReply true
/config streamingReply false
/config clear groupKeywords
/config clear all
```

可热更新的范围仅包括 `groupPolicy`、`groupKeywords`、`groupAlsoOnReply`、`ignoreBotMessages`、`reactEmoji`、`language` 及流式展示参数；应用凭证、引用消息展开和连接方式不能通过聊天修改。

## 同一台机器多开（多工作区 / 多机器人）

**硬前提：一个工作区一个机器人（各自的 `appId`）。** 飞书长连接是集群模式、**不广播** —— 同一个应用即使开了多条连接，每条事件也只会随机推给其中一条。两个实例共用一个 `appId` 会互相抢连接（日志里出现 `system busy`），并让消息随机落到错误的工作区。连接锁按 `appId` 全局互斥，就是为了拦住这种误配。

**实例目录跟着工作区走（0.6.0 起）**：不需要设任何环境变量，每个工作区天然用自己的 `<工作区>/.pi/feishu`，配置、状态、日志、去重、附件都只认本工作区：

```bash
cd ~/work/a && pi     # 工作区 A：直接用
cd ~/work/b && pi     # 工作区 B：直接用（各自机器人凭证写在各自的 .pi/feishu 里）
```

升级说明：旧版把 `~/.pi/agent/feishu` 当全局主实例。升级后首次在某个工作区启动时，如果那份旧数据确实属于这个工作区（属主记录或锁 owner 指向它），会**整份搬进**本工作区实例目录；不属于本工作区时只打印一句提示，绝不搬走别人的数据。

**裸开保护**：万一某个工作区共用别人的机器人（例如显式 `FEISHU_DATA_DIR` 指到了别处的实例），桥接会**拒绝自动启动**，状态栏显示「连接属于其他工作区」，并在会话启动时弹一次提示。归属判据：

1. **连接锁当前 owner 的 cwd**（有 daemon 在跑时有效）；
2. **属主工作区记录**（实例目录下的 `owner-workspace.json`）—— 每次成功连上都会记下当时的工作区，所以原 daemon 停了、锁空着也拦得住。

确需临时接管时，设 `FEISHU_ALLOW_FOREIGN_WORKSPACE=1`，或在本目录手动 `/feishu restart`（手动命令不受本保护限制，并会把这目录更新为新的属主）。

**故意不隔离的**只有连接锁 `~/.pi/agent/locks.json`：它必须全局唯一，否则两个实例都能抢到同一个机器人。回调端口按实例目录稳定派生，同一目录每次算出的端口一样，所以飞书开放平台里的回调地址只需配一次；要指定具体端口就显式设 `FEISHU_CARD_ACTION_WEBHOOK_PORT`，显式值优先。

## 会保存哪些文件

| 路径                               | 内容                |
| -------------------------------- | ----------------- |
| `<工作区>/.pi/feishu/config.json` | 机器人凭证和基础配置        |
| `<工作区>/.pi/feishu/runtime-overrides.json` | 通过私聊 `/config` 保存的运行时配置覆盖 |
| `<工作区>/.pi/feishu/state.json`  | 飞书会话和 Pi 会话的映射    |
| `<工作区>/.pi/feishu/bridge.json` | 从飞书发起的 Pi 任务路由信息  |
| `<工作区>/.pi/feishu/debug.log`   | 调试日志              |
| `<工作区>/.pi/feishu/daemon.log`  | daemon 标准输出日志        |
| `<工作区>/.pi/feishu/owner-workspace.json` | 属主工作区记录（搬迁与裸开保护用来判断这份数据属于谁） |
| `<工作区>/.pi/feishu/inbox/`      | 附件收件箱 |
| `~/.pi/agent/locks.json`         | 当前飞书连接的 owner 锁（故意全局唯一）   |
| `~/.pi/agent/sessions/`          | 每个飞书会话对应的 Pi 会话文件 |

设了 `FEISHU_DATA_DIR` 时整表挪到 `$FEISHU_DATA_DIR/`，只有 `locks.json` 例外，它始终留在全局。

## 使用注意

- 图片能不能被识别，取决于当前选中的模型是否支持图片输入。
- 对一条消息或卡片点“回复”后，Pi 会看到原消息内容和你的新问题；这不是把原消息再次发送到群里。
- `/feishu reset` 只清配置和映射，不删会话历史。
- 同一条消息按消息 ID 去重，5 秒内一字不差的重复正文不会再跑一遍。
- 同一个人在同一会话里，**10 分钟内内容相似度 > 90%** 的消息不再开新一轮（改个错别字重发属于这种），只回一句提示；确实要重跑就在开头加「重发」，例如 `重发 把刚才那段再讲一遍`（也可用 `/again`）。短消息（「好」「继续」）不参与这个判断。
- 从 TUI、CLI 或其他渠道创建的任务，不会主动发到飞书。
- `/workspace` 只支持绝对路径或 `~/` 开头的路径。
- 卡片回调默认监听 `0.0.0.0:<派生端口>/webhook/card`，需在飞书开发者后台把交互卡片回调地址指到一个外部可访问的 URL。

## 常见问题

**机器人没回复？** 先看三件事：机器人是否已创建并配置好、`/feishu start` 是否跑过、群聊策略是否要求 `@`。

**群里发消息机器人不理？** `mention` 策略下需要 `@` 机器人；`open` 策略下可直接回复，但还需在飞书开发者后台开启“获取群组中所有消息”权限。

**两个工作区的机器人互相抢连接 / 消息落错工作区？** 看是不是两个实例用了同一个 `appId` —— 必须一个工作区一个自建应用。只有在显式设了 `FEISHU_DATA_DIR`、把两个工作区指到同一实例目录时才会撞车，此时「裸开保护」会拒绝自动启动并标注「连接属于其他工作区」。

**能开机自启动吗？** 暂未实现。目前需要电脑开机后手动启动一次 Pi agent，之后即可关闭前台，在飞书/Lark 里继续对话。

## 发布（维护者）

npm 包名 `@suwenguang/pi-feishu-bridge`，发布由 GitHub Actions 走 **OIDC 信任发布**，仓库里不放任何 token。
tag 一推就自动发，不需要任何人扫码。

### 发一个版本

```bash
cd .pi/git/gitee.com/suveng/pi-feishu-bridge
npm version patch --no-git-tag-version   # 或 minor / 手改 package.json
git commit -am "chore(发布): 0.6.3"
git tag v0.6.3
git push origin main v0.6.3              # gitee
git push github main v0.6.3              # GitHub（触发 Actions）
```

成功征兆（三步都要看到，缺一条就是没发成）：

1. https://github.com/suveng/pi-feishu-bridge/actions 里 `publish` 运行变绿，日志末尾有 `+ @suwenguang/pi-feishu-bridge@0.6.3`
2. 日志里出现 `Provenance statement published to transparency log`（OIDC 签名成功）
3. 等 1-2 分钟后 `npm view @suwenguang/pi-feishu-bridge version --registry=https://registry.npmjs.org` 返回新版本号

> 发布成功后 registry 还要 1-2 分钟才可见，期间 `npm view` 报 404 属正常（新包风控），不要重发。

### 也可以手动触发

Actions 页面 → `publish` → Run workflow（`workflow_dispatch`），条件同样是 `package.json` 的版本号还没发过。

### 前置配置（只在首次或改包名/改仓库时做一次）

1. **首次发布必须手动**：npm 不允许给「还不存在的包」预配 OIDC，第一个版本只能用 `npm login` + 2FA 手动 `npm publish --access public`。
   非交互环境（脚本 / Agent）下 npm 会把 2FA 链接打码成 `***`，要用 pty 才能拿到真链接：`script -q /dev/null npm publish --access public`。
2. **Trusted Publisher**：https://www.npmjs.com/package/@suwenguang/pi-feishu-bridge/access
   —— Publisher `GitHub Actions` / Organization `suveng` / Repository `pi-feishu-bridge` / Workflow filename `publish.yml` / Environment 留空。
   四项逐字匹配，改工作流文件名就必须同步改这里，否则发布报 `E404 ... could not be found or you do not have permission`。
3. **仓库内 `.npmrc` 必须固定官方源**（`registry=https://registry.npmjs.org/`）：本机全局 `.npmrc` 用的是 npmmirror，
   一旦 `package-lock.json` 里出现 `registry.npmmirror.com` 的 `resolved` 地址，CI 的 `npm ci` 会直接失败：
   `npm error code EALLOWREMOVE` / `Fetching packages of type "remote" have been disabled`。
   遇到时的修法：删掉 `package-lock.json` → `npm install --package-lock-only --registry=https://registry.npmjs.org` 重新生成。

### npm 作用域说明

本账号 npm 用户名是 `suwenguang`，`@suveng` 作用域属于另一个账号（用户 `suveng`），本项目无法使用。
