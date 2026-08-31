// 入口：飞书长连接 ←→ 本机 Claude Code。
import * as Lark from "@larksuiteoapi/node-sdk";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { config, isAllowedSender, resolveWorkspacePath } from "./config.js";
import {
  addTypingReaction,
  removeReaction,
  sendCard,
  sendText,
  updateCard,
} from "./feishu/client.js";
import {
  approvalCard,
  approvalResolvedCard,
  modelPickerCard,
  progressCard,
  replyCard,
  sessionListCard,
} from "./feishu/cards.js";
import { decodeEnvelope, DECODE_FAILURE_TEXT, type CardEnvelope } from "./feishu/envelope.js";
import { TurnStream } from "./feishu/turn-stream.js";
import {
  attachMessageId,
  createApproval,
  describeToolCall,
  isPreApproved,
  resolveApproval,
  signatureOf,
} from "./claude/approvals.js";
import { ClaudeSession } from "./claude/session.js";
import { listSessions, sessionExists } from "./claude/history.js";
import {
  getBinding,
  isSessionExpired,
  resetSession,
  sessionKey,
  touchBinding,
  updateBinding,
} from "./store.js";
import { HELP_TEXT, parseCommand } from "./commands.js";
import { isDuplicate } from "./dedup.js";
import { announceOnce, diagnose } from "./claude/errors.js";
import { isPaired, listApproved, requestPairing, watchPairing } from "./pairing.js";
import { cliCommand } from "./cli-hint.js";

// ---------- 会话管理 ----------

type Live = { session: ClaudeSession; chatId: string };
const live = new Map<string, Live>();

/** 会话键 → 当前轮加在用户消息上的「正在输入」表情，一轮结束就撤掉 */
const typingByKey = new Map<string, { messageId: string; reactionId: string }>();

/** open_id → 他发起配对时所在的会话，批准后用来回他一句 */
const pendingChatByOpenId = new Map<string, string>();

function cardCtx(chatId: string, operatorOpenId: string) {
  return { operatorOpenId, chatId, expiresAt: Date.now() + config.approvalTimeoutMs };
}

/**
 * canUseTool 的飞书实现：预批过的直接放行，否则发卡片并挂起等待。
 * 对同一 request_id 必须幂等 —— reinitialize 之后 SDK 会重投同一个请求。
 */
function makeApprovalBridge(chatId: string, operatorOpenId: string) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    const signature = signatureOf(toolName, input);

    if (isPreApproved(signature)) {
      return { behavior: "allow", updatedInput: input };
    }

    const { requestId, decision } = createApproval({
      toolName,
      signature,
      chatId,
      onTimeout: async (entry) => {
        if (entry.messageId) {
          await updateCard(
            entry.messageId,
            approvalResolvedCard({
              requestId: entry.requestId,
              toolName: entry.toolName,
              decision: "timeout",
              by: "无人响应",
            }),
          );
        }
      },
    });

    const messageId = await sendCard(
      chatId,
      approvalCard({
        requestId,
        toolName,
        detail: describeToolCall(toolName, input),
        ctx: cardCtx(chatId, operatorOpenId),
      }),
    );
    attachMessageId(requestId, messageId);

    const result = await decision;
    if (result === "deny") {
      return { behavior: "deny", message: "用户在飞书上拒绝了此操作" };
    }
    return { behavior: "allow", updatedInput: input };
  };
}

function getOrCreateSession(params: {
  key: string;
  chatId: string;
  operatorOpenId: string;
  resumeSessionId?: string;
  fork?: boolean;
}): ClaudeSession {
  const existing = live.get(params.key);
  if (existing && !params.resumeSessionId) return existing.session;

  void existing?.session.dispose();

  let binding = getBinding(params.key);

  // 闲置太久的会话不再续用，直接作废开新的
  if (binding.sessionId && isSessionExpired(binding)) {
    console.log(`[会话] ${params.key} 已闲置超过 ${config.sessionTtlMs / 3600000} 小时，开新会话`);
    binding = resetSession(params.key);
  }

  // 默认续用上一次的会话：进程重启后也能接上，用户不用管会话概念。
  // 显式 resume / fork 优先。
  const resumeSessionId =
    params.resumeSessionId ?? (params.fork ? undefined : binding.sessionId);

  const stream = new TurnStream({
    sendCard: (card) => sendCard(params.chatId, card),
    updateCard: (messageId, card) => updateCard(messageId, card),
    renderProgress: (steps, done, footer) =>
      progressCard({ steps, done, ...(footer ? { footer } : {}) }),
    // 回复走卡片：飞书纯文本不渲染 markdown
    sendReply: (text) => sendCard(params.chatId, replyCard(text)),
    onError: (err) => console.error("[card] 更新失败:", err),
  });

  const session = new ClaudeSession(
    {
      cwd: binding.cwd,
      ...(binding.model ? { model: binding.model } : {}),
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(params.fork ? { fork: true } : {}),
    },
    {
      onStep: (step) => {
        stream.addStep(step);
      },
      onText: (text) => {
        stream.addText(text);
      },
      onResult: (summary) => {
        const footer = `用时 ${(summary.durationMs / 1000).toFixed(1)}s　约 $${summary.costUsd.toFixed(4)}`;
        stream.finish(summary.text, footer);
        // 等卡片和回复都发完再撤「正在输入」，否则会先变回未读状态
        void stream.drain().then(() => clearTyping(params.key));
      },
      onError: async (err) => {
        // 不要把 SDK 堆栈甩给用户：翻译成人话 + 明确的下一步
        const diagnosis = diagnose(err);
        announceOnce(diagnosis);
        clearTyping(params.key);
        await sendText(params.chatId, diagnosis.chatMessage);
      },
      onSessionId: (sessionId) => {
        updateBinding(params.key, { sessionId });
      },
    },
    makeApprovalBridge(params.chatId, params.operatorOpenId),
  );

  live.set(params.key, { session, chatId: params.chatId });
  return session;
}

/**
 * 切到指定的历史会话。
 *
 * 先校验记录确实存在：SDK 的 resume 要等下一条消息真正发出去才会报错，
 * 不校验的话用户会收到一句「已恢复」，然后在下一轮莫名其妙地失败。
 * 绑定也在这里立刻写回，否则 /status 显示的还是旧会话
 * —— onSessionId 要等第一条消息才回调。
 */
async function resumeSession(params: {
  key: string;
  chatId: string;
  operatorOpenId: string;
  sessionId: string;
}): Promise<void> {
  const binding = getBinding(params.key);
  if (!sessionExists(binding.cwd, params.sessionId)) {
    await sendText(
      params.chatId,
      `在 ${binding.cwd} 下找不到会话 ${params.sessionId}。\n发 /sessions 看看有哪些可恢复的。`,
    );
    return;
  }

  await live.get(params.key)?.session.dispose();
  live.delete(params.key);
  updateBinding(params.key, { sessionId: params.sessionId });
  getOrCreateSession({
    key: params.key,
    chatId: params.chatId,
    operatorOpenId: params.operatorOpenId,
    resumeSessionId: params.sessionId,
  });
  await sendText(params.chatId, `已恢复会话 ${params.sessionId}，直接接着说就行。`);
}

/** 撤掉某个会话当前的「正在输入」表情。 */
function clearTyping(key: string): void {
  const typing = typingByKey.get(key);
  if (!typing) return;
  typingByKey.delete(key);
  void removeReaction(typing.messageId, typing.reactionId);
}

/** 标记「已收到，正在处理」。同一会话连发多条时，先撤旧的再加新的。 */
async function markTyping(key: string, messageId: string): Promise<void> {
  clearTyping(key);
  const reactionId = await addTypingReaction(messageId);
  if (reactionId) typingByKey.set(key, { messageId, reactionId });
}

// ---------- 授权与配对 ----------

/** .env 里的 owner 白名单，或经终端批准过的配对用户。 */
function isAuthorized(openId: string | undefined): boolean {
  return isAllowedSender(openId) || isPaired(openId);
}

/**
 * 陌生人发消息：不处理内容，只发一个配对码，并在终端打印批准命令。
 * 同一个人在码有效期内重复发消息不会反复生成新码，也就不会被反复回复。
 */
async function handleUnknownSender(params: {
  openId: string | undefined;
  chatId: string;
}): Promise<void> {
  const { openId, chatId } = params;
  if (!openId) return;

  pendingChatByOpenId.set(openId.trim().toLowerCase(), chatId);
  const outcome = requestPairing({ openId, chatId });

  if (outcome.kind === "rejected_full") {
    console.warn(`[配对] 待批准请求已达上限，忽略 ${openId}`);
    return;
  }

  const { code } = outcome.request;

  if (outcome.kind === "created") {
    const approveCmd = cliCommand(`pair approve ${code}`);
    console.log("\n" + "=".repeat(52));
    console.log(`[配对] 新的接入请求：${openId}`);
    console.log(`[配对] 批准请在另一个终端运行：`);
    console.log(`\n    ${approveCmd}\n`);
    console.log("=".repeat(52) + "\n");
    await sendText(
      chatId,
      `你还没有被授权使用这台机器。\n\n配对码：${code}\n\n请让机器主人在终端运行：\n${approveCmd}\n\n批准后我会通知你。`,
    );
  }
}

// ---------- 消息事件 ----------

async function handleMessage(data: any): Promise<void> {
  const message = data?.message;
  const openId: string | undefined = data?.sender?.sender_id?.open_id;
  const chatId: string | undefined = message?.chat_id;
  if (!message || !chatId) return;
  if (isDuplicate(message.message_id)) return;

  if (!isAuthorized(openId)) {
    await handleUnknownSender({ openId, chatId });
    return;
  }

  // 群聊必须 @ 机器人才响应，私聊不用
  const isGroup = message.chat_type === "group";
  const mentioned = Array.isArray(message.mentions) && message.mentions.length > 0;
  if (isGroup && !mentioned) return;

  if (message.message_type !== "text") {
    await sendText(chatId, "目前只支持文本消息。");
    return;
  }

  let text = "";
  try {
    text = String(JSON.parse(message.content ?? "{}").text ?? "");
  } catch {
    return;
  }
  // 去掉 @机器人 的占位
  text = text.replace(/@_user_\d+/g, "").trim();
  if (!text) return;

  const key = sessionKey({ chatId, threadId: message.thread_id });
  const operatorOpenId = openId!;
  const command = parseCommand(text);

  switch (command.kind) {
    case "help":
      await sendText(chatId, HELP_TEXT);
      return;

    case "pwd": {
      await sendText(chatId, getBinding(key).cwd);
      return;
    }

    case "status": {
      const binding = getBinding(key);
      await sendText(
        chatId,
        [
          `会话：${binding.sessionId ?? "(尚未建立)"}`,
          `目录：${binding.cwd}`,
          `模型：${binding.model ?? "默认"}`,
        ].join("\n"),
      );
      return;
    }

    case "cd": {
      const resolved = resolveWorkspacePath(command.dir);
      if (!resolved) {
        await sendText(chatId, `不允许：目录必须在 ${config.workspaceRoot} 之内。`);
        return;
      }
      updateBinding(key, { cwd: resolved, cwdExplicit: true });
      await live.get(key)?.session.dispose();
      live.delete(key);
      await sendText(chatId, `工作目录已切换到 ${resolved}，下条消息将开新会话。`);
      return;
    }

    case "new": {
      await live.get(key)?.session.dispose();
      live.delete(key);
      resetSession(key);
      if (command.model) updateBinding(key, { model: command.model });
      await sendText(chatId, `已开新会话${command.model ? `（模型 ${command.model}）` : ""}。`);
      return;
    }

    case "fork": {
      const binding = getBinding(key);
      if (!binding.sessionId) {
        await sendText(chatId, "当前还没有可分叉的会话。");
        return;
      }
      await live.get(key)?.session.dispose();
      live.delete(key);
      getOrCreateSession({
        key,
        chatId,
        operatorOpenId,
        resumeSessionId: binding.sessionId,
        fork: true,
      });
      await sendText(chatId, "已分叉，原会话保留。");
      return;
    }

    case "sessions": {
      const binding = getBinding(key);
      const sessions = await listSessions(binding.cwd);
      if (sessions.length === 0) {
        await sendText(chatId, `${binding.cwd} 下还没有历史会话。`);
        return;
      }
      await sendCard(
        chatId,
        sessionListCard({
          sessions,
          ...(binding.sessionId ? { current: binding.sessionId } : {}),
          cwd: binding.cwd,
          sessionKey: key,
          ctx: cardCtx(chatId, operatorOpenId),
        }),
      );
      return;
    }

    case "resume": {
      await resumeSession({ key, chatId, operatorOpenId, sessionId: command.sessionId });
      return;
    }

    case "model": {
      const session = getOrCreateSession({ key, chatId, operatorOpenId });
      if (command.model) {
        await session.setModel(command.model);
        updateBinding(key, { model: command.model });
        await sendText(chatId, `模型已切换为 ${command.model}。`);
        return;
      }
      const models = await session.listModels();
      await sendCard(
        chatId,
        modelPickerCard({
          models,
          ...(getBinding(key).model ? { current: getBinding(key).model } : {}),
          sessionKey: key,
          ctx: cardCtx(chatId, operatorOpenId),
        }),
      );
      return;
    }

    case "stop": {
      await live.get(key)?.session.interrupt();
      await sendText(chatId, "已请求中断。");
      return;
    }

    case "approve": {
      const entry = resolveApproval(command.requestId, command.decision);
      if (!entry) {
        await sendText(chatId, `请求 ${command.requestId} 不存在或已处理。`);
        return;
      }
      if (entry.messageId) {
        await updateCard(
          entry.messageId,
          approvalResolvedCard({
            requestId: entry.requestId,
            toolName: entry.toolName,
            decision: command.decision,
            by: "通过命令处理",
          }),
        );
      }
      return;
    }

    case "chat": {
      touchBinding(key);
      void markTyping(key, message.message_id);
      const session = getOrCreateSession({ key, chatId, operatorOpenId });
      session.send(command.text);
      return;
    }
  }
}

// ---------- 卡片回调 ----------

/**
 * 回调的响应体。
 *
 * 这是让卡片「点完就变样」的唯一可靠途径：飞书客户端会拿响应里的 card
 * 重新渲染这条消息，响应里没有 card 就把它本地那份旧卡片渲染回去
 * —— 表现就是审批卡闪一下变成已授权，然后又变回可点的样子。
 * 光调更新卡片接口是不够的，会被这次回渲盖掉。
 *
 * 另有一条硬约束：必须 3 秒内响应，超时报 200341。所以耗时的活儿
 * （dispose 要等当前这轮跑完、setModel 要先把 query 拉起来）一律先应答
 * 再后台做，完成后照常在会话里回一句。
 */
type CardResponse = {
  toast?: { type: "info" | "success" | "error" | "warning"; content: string };
  card?: { type: "raw"; data: unknown };
};

/**
 * 卡片作用在哪条会话上。
 *
 * 优先用信封里带的键：回调事件里没有 thread_id，现推只能推出 chat 级别的键，
 * 在话题里点按钮就会操作到群本身的会话上。老卡片没带 k，退回现推的旧行为。
 */
function sessionKeyOf(envelope: CardEnvelope, chatId: string): string {
  return ("k" in envelope && envelope.k) || sessionKey({ chatId });
}

async function handleCardAction(data: any): Promise<CardResponse> {
  const operatorOpenId: string | undefined = data?.operator?.open_id;
  const chatId: string | undefined = data?.context?.open_chat_id ?? data?.context?.chat_id;

  // 飞书会重投回调。不去重的话，第一次已经把请求从 pending 表里消费掉，
  // 第二次就会误报「已处理或已超时」，让用户以为授权没生效。
  const dedupKey =
    data?.token ??
    data?.event_id ??
    `${operatorOpenId}:${data?.context?.open_message_id}:${JSON.stringify(data?.action?.value)}`;
  if (isDuplicate(`card:${dedupKey}`)) return {};

  const decoded = decodeEnvelope({
    value: data?.action?.value,
    operatorOpenId,
    chatId,
    // 必须和消息走同一套判断：只认 allowFrom 的话，配对进来的人能聊天
    // 却点不动任何按钮，每次都被告知「你不在授权名单里」。
    isAllowed: isAuthorized,
  });

  if (!decoded.ok) {
    return { toast: { type: "error", content: DECODE_FAILURE_TEXT[decoded.reason] } };
  }

  const envelope: CardEnvelope = decoded.envelope;

  if (envelope.a === "approval") {
    const entry = resolveApproval(envelope.r, envelope.d);
    if (!entry) {
      // 走到这里说明不是重投（重投已被去重挡掉），而是请求真的不在了：
      // 已超时、已被别的入口处理，或桥接器重启过（pending 表是内存态）。
      return {
        toast: {
          type: "error",
          content: "这条授权请求已失效（超时、已处理，或桥接器重启过），请重新发一次你的需求。",
        },
      };
    }

    const resolved = approvalResolvedCard({
      requestId: entry.requestId,
      toolName: entry.toolName,
      decision: envelope.d,
      by: "已由授权人处理",
    });

    // 更新接口是兜底：把服务端存的那份也改掉（超时和 /approve 两条路径只有它）。
    // 不 await —— 授权已经生效了，不能为了一个网络往返把 3 秒预算耗在这儿。
    if (entry.messageId) {
      void updateCard(entry.messageId, resolved).then((updated) => {
        if (!updated) console.warn(`[审批] ${entry.requestId} 已生效，但卡片未能改成已授权状态`);
      });
    } else {
      // 之前这里是静默跳过，卡片停在待授权状态却毫无线索
      console.warn(`[审批] ${entry.requestId} 没有 messageId，无法更新卡片状态`);
    }

    return {
      toast: { type: "success", content: envelope.d === "deny" ? "已拒绝" : "已允许" },
      card: { type: "raw", data: resolved },
    };
  }

  if (envelope.a === "resume" && chatId) {
    void resumeSession({
      key: sessionKeyOf(envelope, chatId),
      chatId,
      operatorOpenId: operatorOpenId!,
      sessionId: envelope.s,
    }).catch((err) => console.error("[卡片] 恢复会话失败:", err));
    return { toast: { type: "info", content: "正在恢复该会话…" } };
  }

  if (envelope.a === "model" && chatId) {
    const key = sessionKeyOf(envelope, chatId);
    void (async () => {
      const session = getOrCreateSession({ key, chatId, operatorOpenId: operatorOpenId! });
      await session.setModel(envelope.m);
      updateBinding(key, { model: envelope.m });
      await sendText(chatId, `模型已切换为 ${envelope.m}。`);
    })().catch((err) => console.error("[卡片] 切换模型失败:", err));
    return { toast: { type: "success", content: `正在切换到 ${envelope.m}` } };
  }

  return {};
}

// ---------- 启动 ----------

function main(): void {
  if (config.workspaceRoot === process.cwd()) {
    console.warn(
      "[启动] ⚠️ 工作目录就是桥接器自身目录，Claude 会在桥接器的代码里干活。\n" +
        "        请在 .env 里把 BRIDGE_WORKSPACE_ROOT 指向你真正的项目目录。",
    );
  }

  if (config.allowFrom.length === 0) {
    console.warn(
      "[启动] FEISHU_ALLOW_FROM 为空，任何人都无法使用本机器人。请填入你的 open_id。",
    );
  }

  const wsClient = new Lark.WSClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
  });

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data: any) => {
      try {
        await handleMessage(data);
      } catch (err) {
        console.error("[feishu] 处理消息出错:", err);
      }
    },
    "card.action.trigger": async (data: any) => {
      try {
        return await handleCardAction(data);
      } catch (err) {
        console.error("[feishu] 处理卡片回调出错:", err);
        return { toast: { type: "error", content: "处理失败，请看桥接器日志。" } };
      }
    },
  } as any);

  // 配对文件一变（通常是你在另一个终端批准了谁），就通知等待中的人
  let knownApproved = new Set(listApproved());
  watchPairing(() => {
    const current = listApproved();
    for (const openId of current) {
      if (knownApproved.has(openId)) continue;
      const chatId = pendingChatByOpenId.get(openId);
      if (chatId) {
        void sendText(chatId, "已获授权，现在可以直接跟我说话了。");
        pendingChatByOpenId.delete(openId);
      }
    }
    knownApproved = new Set(current);
  });

  wsClient.start({ eventDispatcher });
  console.log(`[启动] 已连接飞书长连接。workspace=${config.workspaceRoot}`);
  console.log(`[启动] 授权用户 ${config.allowFrom.length} 人`);
}

main();
