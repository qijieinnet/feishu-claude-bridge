// 斜杠命令解析。
//
// 沿用 OpenClaw 的一条重要设计：只有「整条消息就是一个命令」时才当命令处理，
// 参数匹配不上就退化成普通聊天内容 —— 避免把正常对话误当指令执行。
import type { ApprovalDecision } from "./feishu/envelope.js";

export type ParsedCommand =
  | { kind: "new"; model?: string }
  | { kind: "fork" }
  | { kind: "resume"; sessionId: string }
  | { kind: "sessions" }
  | { kind: "model"; model?: string }
  | { kind: "stop" }
  | { kind: "cd"; dir: string }
  | { kind: "status" }
  | { kind: "pwd" }
  | { kind: "help" }
  | { kind: "approve"; requestId: string; decision: ApprovalDecision }
  | { kind: "chat"; text: string };

const DECISIONS: ApprovalDecision[] = ["allow-once", "allow-always", "deny"];

export function parseCommand(raw: string): ParsedCommand {
  const text = raw.trim();
  if (!text.startsWith("/")) return { kind: "chat", text };

  // 命令必须独占一条消息；多行的一律当聊天
  if (text.includes("\n")) return { kind: "chat", text };

  const [head = "", ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (head.toLowerCase()) {
    case "new":
      return { kind: "new", ...(arg ? { model: arg } : {}) };
    case "fork":
      return { kind: "fork" };
    case "resume":
      return arg ? { kind: "resume", sessionId: arg } : { kind: "chat", text };
    case "sessions":
      return { kind: "sessions" };
    case "model":
      return { kind: "model", ...(arg ? { model: arg } : {}) };
    case "stop":
      return { kind: "stop" };
    case "cd":
      return arg ? { kind: "cd", dir: arg } : { kind: "chat", text };
    case "status":
      return { kind: "status" };
    case "pwd":
      return { kind: "pwd" };
    case "help":
      return { kind: "help" };
    case "approve": {
      const [requestId, decision] = rest;
      if (!requestId || !decision) return { kind: "chat", text };
      const normalized = decision.toLowerCase() as ApprovalDecision;
      if (!DECISIONS.includes(normalized)) return { kind: "chat", text };
      return { kind: "approve", requestId, decision: normalized };
    }
    default:
      // 不认识的命令当普通消息，别打断聊天
      return { kind: "chat", text };
  }
}

export const HELP_TEXT = [
  "直接说话即可，会自动接着上次的会话。闲置 12 小时后自动开新会话。",
  "",
  "**命令**（需整条消息只有命令）",
  "",
  "`/new [模型]` 立即开一条新会话，可顺带指定模型",
  "`/fork` 从当前会话分叉，原会话保留",
  "`/sessions` 列出本目录下的历史会话，点按钮直接恢复",
  "`/resume <sessionId>` 恢复指定会话",
  "`/model [名称]` 不带参数弹模型选择卡片；带参数直接切换",
  "`/stop` 中断当前执行",
  "`/cd <相对目录>` 切换工作目录（限 workspace 内）",
  "`/pwd` 显示当前工作目录",
  "`/status` 查看当前会话、模型、目录",
  "`/approve <请求ID> allow-once|allow-always|deny` 审批兜底",
  "`/help` 显示本帮助",
].join("\n");
