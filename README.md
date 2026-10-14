# pi-feishu-bridge

Pi 接入 飞书/Lark 的消息桥接扩展：在熟悉的聊天界面里与本机 Pi 持续协作。

<p align="center">
  <b>中文</b> · <a href="./README_EN.md">English</a>
</p>

Pi 飞书交流反馈群：<https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=57dvecbb-95d3-4d01-b689-6ebc3d17c867>

扩展有什么问题可以加群反馈。

## 我的媒体平台 关注我第一时间了解最新AI工具

全平台账号名称：AX阿煊

B站：<https://space.bilibili.com/4489397>


## 主要能力

- 通过扫码快速创建飞书/Lark 机器人，减少手动配置
- 支持私聊、群聊、群话题分别维护独立的 Pi 会话
- 支持群聊策略：
  - `open`：群里和话题里可直接回复，不需要 @，还需手动在飞书开发者后台开启机器人“**获取群组中所有消息”的权限**
  - `mention`：只有 `@` 机器人、命中关键词或回复机器人消息时才会回复（后两项可选开启）
- 支持图片、代码文件和文本文件等附件输入；图片识别取决于当前模型是否支持图片
- 支持压缩包（.zip）附件：下载到本地收件箱（`<工作区>/.pi/feishu/inbox/<消息ID>/`）并把路径写进 prompt，由 agent 自行解压读取，避免大日志包被上下文截断
- 支持解析飞书 interactive 告警卡片；回复一条消息或卡片时，可把原内容一并带给 Pi
- 支持群聊关键词触发、回复机器人消息继续追问
- 支持在飞书内切换当前会话的模型、工作区、历史会话和思考强度
- 收到消息后立即显示“正在回复…”，后续答案在同一张卡片中流式输出；可停止，并会显示完成或失败状态
- 支持渲染显示 Markdown 格式内容
- Pi agent 关闭后，仍有后台常驻服务可以对话，pi agent无需前台运行。

<br />

***



## 快速开始

<a id="pi-quick-start"></a>

### Pi

#### 1. 安装

```bash
pi install npm:ax-feishu-bridge
```

> npm 上的发布名仍是 `ax-feishu-bridge`（与仓库名不同），这条装的即本仓代码。

也可以从 Git 安装：

```bash
pi install git:gitee.com/suveng/pi-feishu-bridge
```

#### 2. 初始化配置

在 Pi 里运行：

```bash
/feishu setup
```

推荐选择“扫码自动创建飞书助手”，按提示扫描终端里的二维码即可。

如果你已经有现成的飞书/Lark 应用，也可以选择手动填写 App ID 和 App Secret。

#### 3. 启动桥接

```bash
/feishu start
```

如果开启了自动启动，Pi 会话启动时会自动连上飞书/Lark。

#### 4. 开始聊天

在飞书/Lark 里打开机器人，直接发消息即可。

- 私聊：直接发消息
- 群聊：根据群聊策略决定是否需要 `@` 机器人
- 话题：每个话题会独立对应一个 Pi 会话

**群聊策略设为open后，想要不@机器人就能回复任何群内消息，还需要到飞书开发者后台 - 对应机器人事件与回调 - 打开“获取群组中所有消息”或“获取群组中用户和机器人发送的消息”这两个任意一个权限。**

---

# Windows 上运行 Pi Agent 飞书插件配置方法

## 解决方法

### 1. 先安装 Git for Windows

安装后一般会有这个文件：

```text
C:\Program Files\Git\bin\bash.exe
```

这个就是 Windows 上给 Pi 使用的 Bash 环境。

---

### 2. 配置 Pi 的 settings.json

打开：

```text
C:\Users\你的用户名\.pi\agent\settings.json
```

在大括号里加这一行：

```json
"shellPath": "C:\\Program Files\\Git\\bin\\bash.exe"
```

注意：如果你原来文件里还有其他配置，不要删掉，只加这一行即可。

这个配置主要是告诉 **Pi 主程序** 使用哪个 Bash。

---

### 3. 把 Git Bash 加到 Windows PATH

有些插件会直接调用：

```text
bash
```

它不一定读取 Pi 的 `shellPath` 配置，所以还需要把 Git Bash 加到系统 PATH。

在 PowerShell 里执行：

```powershell
[Environment]::SetEnvironmentVariable(
  "Path",
  [Environment]::GetEnvironmentVariable("Path", "User") + ";C:\Program Files\Git\bin",
  "User"
)
```

---

### 4. 重启 PowerShell

执行完上面的命令后，要关闭 PowerShell，再重新打开。

然后验证：

```powershell
where.exe bash
```

如果输出：

```text
C:\Program Files\Git\bin\bash.exe
```

说明修复成功。

---

### 5. 再运行 Pi

```powershell
pi
```

---

## 总结

最稳的配置是两个都做：

```text
settings.json 配置 shellPath
+
Windows PATH 加入 C:\Program Files\Git\bin
```

前者给 Pi 主程序用，后者给插件或子进程直接调用 `bash` 用。




***

## 飞书里怎么用

发送给机器人的常用命令：

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

***

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

***

## 配置

配置默认保存在：

```text
<工作区>/.pi/feishu/config.json
```

实例目录默认跟着工作区走（0.6.0 起），机器上不再有全局实例；设 `FEISHU_DATA_DIR` 可显式改到别处（见下方「同一台机器多开」）。
若旧版留下的全局 `~/.pi/agent/feishu` 确实属于本工作区，桥接会在首次启动时把它整份搬进本工作区实例目录，并在日志里说明。

也可以通过环境变量配置：

| 变量                    | 说明                            |
| --------------------- | ----------------------------- |
| `FEISHU_DATA_DIR`     | 实例数据目录；默认跟着工作区走 = `<工作区>/.pi/feishu`（一般不用设），设了则整体改用该目录 |
| `FEISHU_ALLOW_FOREIGN_WORKSPACE` | 设为 `1` 时跳过「裸开保护」（见下方「同一台机器多开」）；仅在自己知道在干什么、要临时接管另一个工作区的机器人时才用 |
| 实例目录下的 `owner-workspace.json` | 桥接自动维护的属主工作区记录（记这份实例数据属于哪个目录），不用手改；搬迁判断与裸开保护都用它 |
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
| `FEISHU_PROMPT_TIMEOUT_SEC` | 任务硬超时秒数，超时后中止任务并报失败，默认 `0`（不设硬超时，长期运行也不会被报失败） |
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

除了上面的环境变量，也可以在 `config.json` 里设置（优先级：环境变量 > config.json > 默认值）：

| 字段                   | 说明                            |
| --------------------- | ----------------------------- |
| `promptNotifySec`     | 长任务超过多少秒后在飞书发一条“仍在处理中”提示，默认 `180`，`0` 关闭 |
| `promptTimeoutSec`    | 任务硬超时秒数，超时后中止任务并报失败，默认 `0`（不设硬超时，长期运行也不会被报失败） |

> 注意：长时间任务（例如跑测试、构建、批量处理）默认**不会**再被报为“任务失败”——到达 `promptNotifySec` 后只会在飞书里提示“任务仍在处理中”，回复卡片保持“回复中”，完成后正常送达结果。只有显式设置 `promptTimeoutSec` 后才会硬超时。修改后请执行 `/feishu restart` 生效。

> 等用户作答（`feishu_ask` 选择题）的时间**不计入**硬超时：暂停等待期间定时器会顺延。
> 选择题本身**不设自动超时**：卡片会一直停在「等待选择」，直到用户点选/自由输入，或被停止按钮、新消息打断。建议把 `promptTimeoutSec` 设为 `0`，便于一眼看出实际耗时口径。

### 运行时配置

以下桥接设置可以在**与机器人的私聊**里用 `/config` 立即修改，无需重启，并保存到实例目录下的 `runtime-overrides.json`（`<工作区>/.pi/feishu/`）：

```text
/config
/config groupKeywords 报警,告警
/config groupAlsoOnReply true
/config streamingReply false
/config clear groupKeywords
/config clear all
```

可热更新的范围仅包括 `groupPolicy`、`groupKeywords`、`groupAlsoOnReply`、`ignoreBotMessages`、`reactEmoji`、`language` 以及流式展示参数；应用凭证、引用消息展开和连接方式不能通过聊天修改。

***

## 同一台机器多开（多工作区 / 多机器人）

**硬前提：一个工作区一个机器人（各自的 `appId`）。** 飞书长连接是集群模式、**不广播** ——
同一个应用即使开了多条连接，每条事件也只会随机推给其中一条。两个实例共用一个 `appId`
会互相抢连接（日志里会出现 `system busy`），并让消息随机落到错误的工作区。
连接锁按 `appId` 全局互斥，就是为了拦住这种误配。

**实例目录跟着工作区走（0.6.0 起）**：不需要设任何环境变量 —— 每个工作区天然用自己的
`<工作区>/.pi/feishu`，配置、状态、日志、去重、附件都只认本工作区，机器上**不再有全局实例**。

```bash
# 工作区 A：直接用
cd ~/work/a && pi

# 工作区 B：直接用（各自的机器人凭证写在各自的 .pi/feishu 里）
cd ~/work/b && pi
```

> 升级说明：旧版把 `~/.pi/agent/feishu` 当全局主实例。升级后首次在某个工作区启动时，
> 如果那份旧数据确实属于这个工作区（属主记录或锁 owner 指向它），会**整份搬进**本工作区实例目录；
> 不属于本工作区时只打印一句提示，绝不搬走别人的数据。想手工指到别处仍可设 `FEISHU_DATA_DIR`。

**裸开保护**：万一某个工作区共用别人的机器人（例如显式 `FEISHU_DATA_DIR` 指到了别处的实例），
桥接会**拒绝自动启动**，状态栏显示「连接属于其他工作区」，并在会话启动时弹一次提示。归属判据：

1. **连接锁当前 owner 的 cwd**（有 daemon 在跑时有效）；
2. **属主工作区记录**（实例目录下的 `owner-workspace.json`）—— 每次成功连上都会记下当时的工作区，
   所以原 daemon 停了、锁空着也拦得住。

确需临时接管时，设 `FEISHU_ALLOW_FOREIGN_WORKSPACE=1`，或在本目录手动 `/feishu restart`
（手动命令不受本保护限制，并会把这目录更新为新的属主）。

实例目录布局（默认 `<工作区>/.pi/feishu`）：

| 项 | 隔离后的位置 |
| --- | --- |
| `config.pi.json` / `state.pi.json` / `bridge.pi.json` / `debug.pi.log` / `daemon.log` / `runtime-overrides.json` | `<工作区>/.pi/feishu/`（设了 `FEISHU_DATA_DIR` 则为 `$FEISHU_DATA_DIR/`） |
| 附件收件箱 | `<实例目录>/inbox/` |
| 卡片回调端口 | 由实例目录派生，稳定落在 `3003-3099` |

**故意不隔离的**只有连接锁：`~/.pi/agent/locks.json`。
它必须全局唯一，否则两个实例都能抢到同一个机器人。

回调端口按目录稳定派生：同一个目录每次算出的端口一样，所以飞书开放平台里的回调地址
只需配一次；不同实例目录自然落到不同端口，不会互抢。要指定具体端口就显式设
`FEISHU_CARD_ACTION_WEBHOOK_PORT`，显式值优先于派生值。

***

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
| `~/.pi/agent/locks.json`         | 当前飞书连接的 owner 锁（故意全局唯一）   |
| `~/.pi/agent/sessions/`          | 每个飞书会话对应的 Pi 会话文件 |

> 连接锁始终放在 `~/.pi/agent/locks.json`：飞书长连接是集群模式、不广播，同一台机器上两个工作区共用同一个机器人会互抢连接，所以锁必须全局唯一。

> 实例目录默认是 `<工作区>/.pi/feishu`；设了 `FEISHU_DATA_DIR` 时整表挪到 `$FEISHU_DATA_DIR/`。只有 `locks.json` 例外，它始终留在全局 —— 必须全局唯一，否则两个实例都能抢到同一个机器人。

***

## 常见说明

- 图片能不能被识别，取决于当前选中的模型是否支持图片输入。
- 图片、文本/代码文件输入是已有能力；interactive 卡片解析和回复消息上下文展开是新版补充的能力。
- 对一条消息或卡片点“回复”后，Pi 会看到原消息内容和你的新问题；这不是把原消息再次发送到群里。
- `/feishu reset` 只会清掉配置和映射，不会删除会话历史。
- 同一条消息桥接只处理一次（按消息 ID 去重），5 秒内一字不差的重复正文也不会再跑一遍。
- 更宽一点：同一个人在同一会话里，**10 分钟内内容相似度 > 90%** 的消息不再开新一轮（改一个错别字重发属于这种），会回一句提示而不是让模型把同一个选择题再问一遍。确实要重跑就在开头加「重发」，例如 `重发 把刚才那段再讲一遍`（也可用 `/again`）。短消息（「好」「继续」）不参与这个判断。
- 从 TUI、CLI 或其他渠道创建的任务，不会主动发到飞书。
- `/workspace` 当前只支持绝对路径，或 `~/` 开头的路径。
- `/resume` 默认先显示当前项目的最近历史会话，也可以在卡片里切到“全部会话”并翻页浏览。
- 卡片按钮现在优先走 webhook 回包模式；如果你还想临时沿用旧的 WS 更新方式，可以把 `FEISHU_CARD_ACTION_MODE` 设成 `ws`。
- 卡片回调默认监听 `0.0.0.0:<派生端口>/webhook/card`：端口按实例目录稳定派生到 `3003-3099`，需要在飞书开发者后台把交互卡片回调地址指到一个外部可访问的 URL；要固定端口就显式设 `FEISHU_CARD_ACTION_WEBHOOK_PORT`。

***

## 常见问题

### 为什么机器人没回复？

先看三件事：

- 飞书机器人是否已经创建并配置好
- `/feishu start` 是否已经运行
- 群聊策略是否要求 `@` 机器人

### 为什么我在群里发了消息，机器人没有理我？

如果你把群聊策略设成了 `mention`，就需要 `@` 机器人后它才会回复。\
`open`模式下：群里和话题里可直接回复，不需要 @，但还需手动在飞书开发者后台开启机器人“获取群组中所有消息”权限才能生效。

### 两个工作区的机器人互相抢连接 / 消息落错工作区？

看是不是两个实例用了**同一个 `appId`**。飞书长连接不广播，同一应用的多条连接会随机分流，必须一个工作区一个自建应用。0.6.0 起实例数据默认跟着工作区走，正常情况下两个工作区天然互不干扰。
只有在显式设了 `FEISHU_DATA_DIR`、把两个工作区指到同一个实例目录时才会撞车：此时桥接的「裸开保护」会拒绝自动启动并把状态栏标成「连接属于其他工作区」（要强行接管才需 `FEISHU_ALLOW_FOREIGN_WORKSPACE=1`）；原 daemon 没在跑时也拦得住 —— 属主工作区记录（实例目录下的 `owner-workspace.json`）记住了这份数据属于哪个目录。

### 还没有实现后台服务开机自启动功能，目前需要电脑开机后手动启动一次 Pi agent 才能正常工作。启动后，Pi agent 无需前台运行，关闭后，仍可以在飞书/Lark 里对话。
