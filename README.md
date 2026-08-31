# feishu-claude-bridge

在飞书里聊天驱动本机的 Claude Code：手机上说一句，代码在你自己的电脑上跑；遇到敏感操作，飞书弹卡片点一下授权。

基于官方 [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) 构建。桥接的是 Claude Code 的 **agent 引擎**（SDK 底层拉起 Claude Code CLI 进程），不是 Claude 桌面 app —— 它是一个独立的 headless 客户端，与你桌面上的 Claude Code 平行，共用同一个账号和 `~/.claude` 配置。

> 一句话风险提示：**跑起来之后，能给这个机器人发消息的人，就等于拿到了你机器上的一个 shell。** 请先读完[安全模型](#安全模型)。

## 特性

- **扫码接入**：`npm run setup` 扫个码，App ID / Secret / 你的 open_id 自动写进 `.env`，不用去开发者后台抄任何东西
- **会话自动延续**：默认接着上次聊，进程重启也能接上；闲置 12 小时才作废并自动开新的
- **过程与回复分离**：思考和工具调用实时刷在过程卡里，**完成后自动折叠成一行**；最终回复单独一张极简卡片
- **卡片授权**：未预批的操作弹卡片，三档 —— 允许一次 / 总是允许 / 拒绝；「总是允许」会记住同类操作
- **配对准入**：陌生人发消息只会拿到一个配对码，你在终端批准后他才能用
- **模型热切**：`/model` 弹卡片选，列表由 SDK 实时提供，不写死
- **正在输入**：收到消息立刻给你那条消息贴 `Typing` 表情，干完自动撤掉

## 快速开始

需要 Node ≥ 20，以及本机已登录的 Claude Code。

### 1. 扫码创建飞书应用

```bash
npm install && npm run setup
```

终端打印二维码，用飞书 App 扫，在手机上选**新建**或**已有**机器人并确认。凭证会自动写入 `.env`。

> 走的是飞书 accounts 域的 OAuth device-code 流程（`archetype=PersonalAgent`）。租户在 Lark 侧时自动切到 larksuite 域。

扫码后如果收不到消息，去开发者后台确认「事件与回调」用的是**长连接**，且订阅了 `im.message.receive_v1`。长连接意味着你不需要公网 IP、内网穿透或 webhook 验签。

### 2. 体检

```bash
npm run doctor
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
  4) 重启桥接器：npm start
```

### 3. 启动

```bash
npm start
```

私聊直接说话，群里 @ 机器人。

## 别人想用：终端批准

陌生人给机器人发消息时，消息**不会被处理**，他只会收到一个 8 位配对码，同时你的终端打印：

```
[配对] 新的接入请求：ou_xxxxxxxx
[配对] 批准请在另一个终端运行：

    npm run pair -- approve MM5965JU
```

批准后桥接器会主动在飞书上告诉对方「已获授权」。

```bash
npm run pair -- list              # 看谁在等
npm run pair -- approve <CODE>    # 批准
npm run pair -- revoke <open_id>  # 撤销
```

配对码 1 小时过期；同一个人在有效期内重复发消息不会反复生成新码；同时最多挂 3 个待批请求，防刷屏。

## 命令

整条消息只有命令时才当命令处理，参数匹配不上会退化成普通聊天 —— 避免把正常对话误当指令。

| 命令 | 作用 |
|---|---|
| `/new [模型]` | 立即开一条新会话，可顺带指定模型 |
| `/fork` | 从当前会话分叉，原会话保留 |
| `/resume <sessionId>` | 恢复指定会话 |
| `/model [名称]` | 不带参数弹模型选择卡片；带参数直接切换 |
| `/stop` | 中断当前执行 |
| `/cd <相对目录>` | 切换工作目录（限 workspace 内） |
| `/pwd` | 显示当前工作目录 |
| `/status` | 查看当前会话、模型、目录 |
| `/approve <请求ID> <决策>` | 卡片失效时的审批兜底 |
| `/help` | 帮助 |

## 配置

| 变量 | 说明 |
|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | `npm run setup` 自动写入 |
| `FEISHU_ALLOW_FROM` | owner 名单（open_id，逗号分隔）。空且无配对用户 = 谁都不能用 |
| `BRIDGE_WORKSPACE_ROOT` | 工作目录根，Claude 只在这里及其子目录活动 |
| `BRIDGE_SESSION_TTL_MS` | 会话闲置多久作废，默认 12 小时 |
| `BRIDGE_APPROVAL_TIMEOUT_MS` | 审批等待超时，默认 30 分钟，超时按拒绝处理 |
| `BRIDGE_DEFAULT_MODEL` | 默认模型，留空用 Claude Code 默认 |

## 安全模型

四道闸：

1. **两级授权名单**：`.env` 里的 owner（setup 自动写入你自己），加上经你在终端批准的配对用户。两者都没有 = 谁都不能用。这是刻意的安全默认 —— 配错了应该是没人能用，而不是所有人都能用。
2. **卡片信封校验**：按钮里带的信封声明了「谁、在哪个会话、在什么期限前」可以点，回调时逐项比对，挡住同群别人替你点、过期后补点、卡片被转发到别处点。
3. **审批超时按拒绝处理**：默认 30 分钟无人响应即 deny，绝不因为没人理就放行。
4. **工作目录限制**：`/cd` 只能在 `BRIDGE_WORKSPACE_ROOT` 之内跳。

**信封为什么不签名**：它不是凭证，只是一份声明。真正的信任锚是飞书回调里的 `operator.open_id`（平台签发，客户端伪造不了）和服务端的 pending 表 + 白名单。

**`permissionMode` 固定为 `default`，不要改成 `bypassPermissions`** —— 那会让 `canUseTool` 变成死代码，权限流程在到达回调之前就放行，所有审批卡片都不再弹。

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
src/
  index.ts              入口：事件分发、会话管理、审批桥接
  config.ts             配置加载与校验、白名单、路径限制
  commands.ts           斜杠命令解析
  store.ts              飞书会话 ↔ Claude sessionId 映射持久化
  pairing.ts            配对码的生成、批准、撤销
  dedup.ts              事件去重（消息与卡片回调共用）
  feishu/
    client.ts           发消息、发卡片、更新卡片、表情回复
    cards.ts            卡片构造（审批 / 模型 / 过程 / 回复）
    envelope.ts         交互信封的构造与校验
    turn-stream.ts      一轮输出的编排：过程卡 + 最终回复，全程串行
  claude/
    session.ts          常驻 query、流式输入、模型与中断控制
    approvals.ts        审批 pending 表、超时、allow-always 落盘
    errors.ts           错误分类与人话提示
  setup/
    register.ts         飞书应用注册（OAuth device-code）
    cli.ts              npm run setup
  cli/
    pair.ts             npm run pair
    doctor.ts           npm run doctor
```

## 已知限制

- 只支持文本消息，图片、文件、语音未处理
- 过程卡是节流刷新，不是逐字打字机效果（要真打字机得接 CardKit 的 `streaming_mode`）
- 待审批请求存在内存里，桥接器重启后失效，需要重新发起
- 一个话题 = 一个会话；不开话题则整个群共用一个会话

## License

MIT
