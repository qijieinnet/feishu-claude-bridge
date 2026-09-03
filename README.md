# feishu-claude-bridge

在飞书里聊天驱动本机的 Claude Code：手机上说一句，代码在你自己的电脑上跑；遇到敏感操作，飞书弹卡片点一下授权。

基于官方 [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) 构建。桥接的是 Claude Code 的 **agent 引擎**（SDK 底层拉起 Claude Code CLI 进程），不是 Claude 桌面 app —— 它是一个独立的 headless 客户端，与你桌面上的 Claude Code 平行，共用同一个账号和 `~/.claude` 配置。

> 一句话风险提示：**跑起来之后，能给这个机器人发消息的人，就等于拿到了你机器上的一个 shell。** 请先读完[安全模型](#安全模型)。

## 特性

- **扫码接入**：`fcb setup` 扫个码，App ID / Secret / 你的 open_id 自动写进 `.env`，不用去开发者后台抄任何东西
- **会话自动延续**：默认接着上次聊，进程重启也能接上；闲置 12 小时才作废并自动开新的
- **过程与回复分离**：思考和工具调用实时刷在过程卡里，**完成后自动折叠成一行**；最终回复单独一张极简卡片
- **卡片授权**：未预批的操作弹卡片，三档 —— 允许一次 / 总是允许 / 拒绝；「总是允许」会记住同类操作
- **选项可点**：Claude 给选项时（`AskUserQuestion`）弹提问卡，一个选项一个按钮，支持多选；选项都不合适就直接发消息，那条消息即为回答
- **配对准入**：陌生人发消息只会拿到一个配对码，你在终端批准后他才能用
- **模型热切**：`/model` 弹卡片选，列表由 SDK 实时提供，不写死
- **正在输入**：收到消息立刻给你那条消息贴 `Typing` 表情，干完自动撤掉

## 安装

需要 Node ≥ 20，以及本机已登录的 Claude Code。

一条命令装好：

```bash
npm i -g feishu-claude-bridge
```

不想全局安装也可以直接跑，不留任何东西：

```bash
npx feishu-claude-bridge setup
```

> 想装还没发布的最新代码，把包名换成 `github:qijieinnet/feishu-claude-bridge` 即可，
> 只是要拉整个仓库再装依赖，慢得多。

## 快速开始

### 1. 扫码创建飞书应用

```bash
feishu-claude-bridge setup
```

终端打印二维码，用飞书 App 扫，在手机上选**新建**或**已有**机器人并确认。App ID、App Secret、以及**你自己的 open_id** 会自动写进 `~/.feishu-claude-bridge/.env` —— 不用去开发者后台抄任何东西。

> 走的是飞书 accounts 域的 OAuth device-code 流程（`archetype=PersonalAgent`）。租户在 Lark 侧时自动切到 larksuite 域。

扫码后如果收不到消息，去开发者后台确认「事件与回调」用的是**长连接**，且订阅了 `im.message.receive_v1`。长连接意味着你不需要公网 IP、内网穿透或 webhook 验签。

### 2. 体检

```bash
feishu-claude-bridge doctor
```

依次检查配置、飞书连通性、Claude 认证，每项给明确结论和修复步骤，而不是一堆堆栈：

```
[1/3] 配置
  ✅ 飞书应用 cli_xxxxxxxx
  ✅ owner 1 人
  ✅ 工作目录 /path/to/your/projects

[2/3] 飞书连通性
  ✅ 凭证有效，能拿到 tenant_access_token

[3/3] Claude 认证（会真的跑一次极短的请求）
  ❌ Claude Code 登录已过期，需要重新登录：
  1) npm i -g @anthropic-ai/claude-code
  2) claude          # 然后用 /login 登录
  3) claude -p "回复 OK"   # 验证认证是否恢复
  4) 重启桥接器
```

### 3. 启动

```bash
feishu-claude-bridge
```

私聊直接说话，群里 @ 机器人。

> 命令有个短别名 `fcb`，`fcb doctor`、`fcb start` 都行。
> 配置和状态都在 `~/.feishu-claude-bridge/`，可用 `BRIDGE_HOME` 覆盖。
> 在仓库目录里跑时，如果当前目录有 `.env` 就优先用它（开发模式）。

## 开机自启

全局安装本身**不会**开机运行 —— 它只是把命令装进 PATH，关掉终端桥接器就停了。要让它常驻：

```bash
feishu-claude-bridge service install
```

macOS 用 LaunchAgent，Linux 用 systemd user service，都是**用户级**的，不需要 sudo，也不碰系统全局配置。装完立即启动，之后开机自动拉起，崩溃会自动重启。

```bash
feishu-claude-bridge service status      # 看是否在运行
feishu-claude-bridge service uninstall   # 取消自启
```

```bash
feishu-claude-bridge service restart     # 换了 node 版本、或想让它重新加载时
```

日志在 `~/.feishu-claude-bridge/logs/out.log`（配对码、审批提示都会打在这里，实时看用 `tail -f`）。

> 一个容易踩的坑：launchd 和 systemd 的默认 `PATH` 极窄，会导致服务起来了却找不到 `claude`。
> 安装时会把你当前 shell 的 `PATH` 一并写进配置，避免这个问题。

### 崩了、被杀了、卡死了，会自己起来吗

| 情况 | 结果 |
| --- | --- |
| 进程被 kill / 崩溃退出 | **会**。launchd `KeepAlive`、systemd `Restart=always`，无条件拉起 |
| 网络抖动、飞书长连接断开 | **会**。SDK 自己重连（120s 一次 ping，掉 pong 就重连） |
| 连上过之后重连耗尽 / 不可恢复的错误 | **会**。这是最阴的一种：SDK 放弃后只发一个 `onError` 就停手，而它的 ping 定时器还在无条件续期，**进程活得好好的**，守护进程看不出任何异常，飞书那边却再也收不到消息。桥接器接住这个回调后主动退出（退出码 1），让守护进程用干净的进程重来 |
| 连接莫名其妙挂住 | **会**。看门狗每 30 秒查一次连接状态，连续掉线超过 `BRIDGE_WATCHDOG_MS`（默认 10 分钟）就主动退出重来。一次正常重连远快于这个阈值，不会误杀 |
| 凭据本身就是错的（App Secret 改过、应用被停用） | 进程起来就退（实测退出码 0，SDK 在这条路上连回调都不发），守护进程每 10 秒重来一次。**这个循环靠重启是好不了的**，日志里会一直刷 `invalid appId`，得去 `fcb setup` 重配 |
| 单条会话卡住（某轮 Claude 不返回） | **不会**，这不是进程级问题。发 `/stop` 中断，或 `/new` 开一条新会话 |

重启不会丢上下文：会话 id 落在磁盘上，重启后照样接着聊。挂着的审批卡和提问卡是内存态，会失效，重发一次需求即可。

日志里能看到全过程：`[连接] 已断开，正在重连…`、`[连接] 重连成功`、`[退出] 桥接器结束，退出码 1`。

## 升级

一条命令：

```bash
fcb upgrade
```

它会**停服务 → 拉新代码 → 重写服务定义并拉起**，一步到位。三件事是刻意做在一起的：

- 装完不重启，后台服务还跑着旧代码 —— 表面升了，行为没变；
- 直接覆盖安装时服务还在跑，会撞上正被替换的文件；
- fnm / nvm 换过 node 版本后，服务定义里记的 node 路径已经不存在，服务会安静地起不来 —— 而人只会觉得「升级把它搞坏了」。重写服务定义顺手就修好了。

**配置、配对记录、会话映射都在 `~/.feishu-claude-bridge`，升级全程不碰，不需要重跑 `setup`，也不需要重设开机自启。**

升级源默认用 npm 包名（装 tarball 比从 GitHub 拉整个仓库快一个数量级）；registry 上取不到时自动退回 `github:` 那条路。

> 从 git 仓库里跑的（开发模式）会走 `git pull --ff-only` + `npm install`，有未提交改动时会先拦下来。
> 想升到某个分支或 fork：`fcb upgrade github:你的用户名/feishu-claude-bridge#分支名`。

机器上装的还是没有 `upgrade` 命令的旧版本时，用这一句过渡（`service install` 本身就是幂等的重装 + 重启）：

```bash
npm i -g feishu-claude-bridge && fcb service install
```
> 如果之后你换了 Node 或 Claude Code 的安装位置，重新跑一次 `service install` 即可。

Linux 上如果希望**未登录时也运行**，还需要：

```bash
sudo loginctl enable-linger $USER
```

## 别人想用：终端批准

陌生人给机器人发消息时，消息**不会被处理**，他只会收到一个 8 位配对码，同时你的终端打印：

```
[配对] 新的接入请求：ou_xxxxxxxx
[配对] 批准请在另一个终端运行：

    feishu-claude-bridge pair approve MM5965JU
```

批准后桥接器会主动在飞书上告诉对方「已获授权」。

```bash
feishu-claude-bridge pair list              # 看谁在等
feishu-claude-bridge pair approve <CODE>    # 批准
feishu-claude-bridge pair revoke <open_id>  # 撤销
```

配对码 1 小时过期；同一个人在有效期内重复发消息不会反复生成新码；同时最多挂 3 个待批请求，防刷屏。

## 命令

整条消息只有命令时才当命令处理，参数匹配不上会退化成普通聊天 —— 避免把正常对话误当指令。

| 命令 | 作用 |
|---|---|
| `/new [模型]` | 立即开一条新会话，可顺带指定模型 |
| `/fork` | 从当前会话分叉，原会话保留 |
| `/sessions` | 列出当前目录下最近的历史会话，点按钮直接恢复 |
| `/resume <sessionId>` | 恢复指定会话 |
| `/model [名称]` | 不带参数弹模型选择卡片；带参数直接切换 |
| `/stop` | 中断当前执行 |
| `/cd <相对目录>` | 切换工作目录（限 workspace 内） |
| `/pwd` | 显示当前工作目录 |
| `/status` | 查看当前会话、模型、思考程度、目录 |
| `/approve <请求ID> <决策>` | 授权卡失效时的兜底（提问卡不用它，直接发消息作答即可） |
| `/help` | 帮助 |

## 配置

| 变量 | 说明 |
|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | `fcb setup` 自动写入 |
| `FEISHU_ALLOW_FROM` | owner 名单（open_id，逗号分隔）。空且无配对用户 = 谁都不能用 |
| `BRIDGE_WORKSPACE_ROOT` | 工作目录根，Claude 只在这里及其子目录活动 |
| `BRIDGE_HOME` | 配置与状态目录，默认 `~/.feishu-claude-bridge` |
| `BRIDGE_SESSION_TTL_MS` | 会话闲置多久作废，默认 12 小时 |
| `BRIDGE_APPROVAL_TIMEOUT_MS` | 审批等待超时，默认 30 分钟，超时按拒绝处理 |
| `BRIDGE_WATCHDOG_MS` | 长连接掉线多久就主动退出重来，默认 10 分钟，设 `0` 关掉 |
| `BRIDGE_DEFAULT_MODEL` | 默认模型，留空用 Claude Code 默认 |

## 安全模型

四道闸：

1. **两级授权名单**：`.env` 里的 owner（setup 自动写入你自己），加上经你在终端批准的配对用户。两者都没有 = 谁都不能用。这是刻意的安全默认 —— 配错了应该是没人能用，而不是所有人都能用。
2. **卡片信封校验**：按钮里带的信封声明了「谁、在哪个会话、在什么期限前」可以点，回调时逐项比对，挡住同群别人替你点、过期后补点、卡片被转发到别处点。
3. **审批超时按拒绝处理**：默认 30 分钟无人响应即 deny，绝不因为没人理就放行。
4. **工作目录限制**：`/cd` 只能在 `BRIDGE_WORKSPACE_ROOT` 之内跳。

**信封为什么不签名**：它不是凭证，只是一份声明。真正的信任锚是飞书回调里的 `operator.open_id`（平台签发，客户端伪造不了）和服务端的 pending 表 + 白名单。

**`permissionMode` 固定为 `default`，不要改成 `bypassPermissions`** —— 那会让 `canUseTool` 变成死代码，权限流程在到达回调之前就放行，所有审批卡片都不再弹。

**提问不是授权**：`AskUserQuestion` 走的是另一条路。SDK 约定「选了什么」必须顺着 `canUseTool` 的 `updatedInput.answers`（问题原文 → 答案）回填，少这一步工具会以 `The user did not answer the questions.` 收场 —— 表现就是 Claude 每次都说你没选。同理，`AskUserQuestion` / `ExitPlanMode` 被硬挡在 allow-always 之外：记住它们等于以后再也不问，而每轮都以「没人作答」告终。

**提问卡的按钮带的是绝对状态（选中/未选中），不是「切换」**：飞书会重投回调，切换语义投两次等于没点；而且回调去重是按内容算的，同一个「切换」连点两次会被当成重复丢掉第二次，多选就永远取消不掉。

**「总是允许」的粒度是刻意保守的**：Bash 只匹配命令的第一个词，文件类只匹配所在目录。宁可多问几次，也不要因为特征太宽而放行了本不该放行的东西。记录在 `data/allowlist.json`，想反悔直接删对应条目。

> 使用授权提醒：Claude Code 订阅是个人使用授权。自己用手机远程操作自己的机器属正常用法；把机器人放进群让多人共用你的额度则属于共享账号，请自行掂量边界。

## 踩过的坑

留给后来者，也留给未来的自己：

- **卡片必须用 JSON 2.0，且组件语法与 1.0 不同**：没有 `tag: "action"` 容器（横排按钮用 `column_set`），回调数据在 `behaviors: [{type: "callback", value}]` 而不是按钮的 `value`，也没有 `tag: "note"`。
- **更新 2.0 卡片要走 cardkit，不是 `im.v1.message.patch`**：后者属于 1.0 时代，带交互组件的卡片更新不动。正确路径是 `message_id` →`cardkit.card.idConvert` → `cardkit.card.update`，且 `sequence` 必须严格递增。
- **飞书会重投事件**：消息和卡片回调都要去重，否则同一条指令跑两遍，或者授权被消费两次导致误报「已失效」。
- **飞书纯文本消息不渲染 markdown**：要格式就得用卡片。
- **单条消息编辑次数约 20 次**：流式刷新会撞上限，需要节流并留余量。
- **`canUseTool` 只在 streaming input 模式下可用**：`prompt` 必须是 async iterable；同时 `setModel` / `interrupt` / `supportedModels` 等控制方法也都依赖它。

## 结构

```
bin/cli.js              统一命令入口（setup / start / pair / doctor / service）
src/
  index.ts              入口：事件分发、会话管理、审批桥接
  config.ts             配置加载与校验、白名单、路径限制
  commands.ts           斜杠命令解析
  store.ts              飞书会话 ↔ Claude sessionId 映射持久化
  pairing.ts            配对码的生成、批准、撤销
  dedup.ts              事件去重（消息与卡片回调共用）
  cli-hint.ts           提示命令时按安装方式选 fcb 还是 npm run
  feishu/
    client.ts           发消息、发卡片、更新卡片、表情回复
    cards.ts            卡片构造（审批 / 提问 / 模型 / 历史会话 / 过程 / 回复）
    envelope.ts         交互信封的构造与校验
    turn-stream.ts      一轮输出的编排：过程卡 + 最终回复，全程串行
  claude/
    session.ts          常驻 query、流式输入、模型与中断控制
    history.ts          读 ~/.claude/projects 下的历史会话记录
    approvals.ts        卡点 pending 表（授权 + 提问）、超时、allow-always 落盘
    errors.ts           错误分类与人话提示
  setup/
    register.ts         飞书应用注册（OAuth device-code）
    cli.ts              fcb setup：扫码注册流程的命令行外壳
  cli/
    pair.ts             配对管理
    doctor.ts           体检
    service.ts          开机自启注册（launchd / systemd）
```

## 已知限制

- 只支持文本消息，图片、文件、语音未处理
- 过程卡是节流刷新，不是逐字打字机效果（要真打字机得接 CardKit 的 `streaming_mode`）
- 待审批请求和挂起的提问卡存在内存里，桥接器重启后失效，需要重新发起
- 一个话题 = 一个会话；不开话题则整个群共用一个会话

## License

MIT
