// 审批中枢：把 canUseTool 的一次调用，变成飞书上的一张卡片和一个可 resolve 的 Promise。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { ApprovalDecision } from "../feishu/envelope.js";

export type PendingApproval = {
  requestId: string;
  toolName: string;
  /** 用于 allow-always 匹配的规范化特征 */
  signature: string;
  chatId: string;
  /** 审批卡的 message_id，决议后原地替换 */
  messageId?: string;
  createdAt: number;
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
};

const pending = new Map<string, PendingApproval>();

// ---------- allow-always 允许列表 ----------

const allowlistPath = path.join(config.dataDir, "allowlist.json");
let allowlist: string[] | null = null;

function loadAllowlist(): string[] {
  if (allowlist) return allowlist;
  try {
    allowlist = JSON.parse(fs.readFileSync(allowlistPath, "utf8")) as string[];
  } catch {
    allowlist = [];
  }
  return allowlist;
}

function saveAllowlist(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(allowlistPath, JSON.stringify(allowlist ?? [], null, 2));
}

/**
 * 把工具调用规范化成一个「同类」特征，供 allow-always 复用。
 *
 * 刻意保守：Bash 只认命令的第一个词，文件类只认所在目录。
 * 宁可多问几次，也不要因为特征太宽而放行了本不该放行的东西。
 */
export function signatureOf(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    const head = command.trim().split(/\s+/)[0] ?? "";
    return `Bash:${head}`;
  }
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
    const file = typeof input.file_path === "string" ? input.file_path : "";
    return `${toolName}:${path.dirname(file)}`;
  }
  return toolName;
}

export function isPreApproved(signature: string): boolean {
  return loadAllowlist().includes(signature);
}

function rememberAlways(signature: string): void {
  const list = loadAllowlist();
  if (!list.includes(signature)) {
    list.push(signature);
    saveAllowlist();
  }
}

// ---------- pending 表 ----------

export function createApproval(params: {
  toolName: string;
  signature: string;
  chatId: string;
  onTimeout: (approval: PendingApproval) => void;
}): { requestId: string; decision: Promise<ApprovalDecision> } {
  const requestId = `req_${crypto.randomBytes(4).toString("hex")}`;

  let resolve!: (decision: ApprovalDecision) => void;
  const decision = new Promise<ApprovalDecision>((r) => {
    resolve = r;
  });

  const timer = setTimeout(() => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    // 超时按拒绝处理 —— 安全默认，绝不能是放行。
    entry.resolve("deny");
    params.onTimeout(entry);
  }, config.approvalTimeoutMs);
  // 别让一个挂起的审批把进程钉在事件循环里
  timer.unref?.();

  const entry: PendingApproval = {
    requestId,
    toolName: params.toolName,
    signature: params.signature,
    chatId: params.chatId,
    createdAt: Date.now(),
    resolve,
    timer,
  };
  pending.set(requestId, entry);

  return { requestId, decision };
}

export function attachMessageId(requestId: string, messageId: string | undefined): void {
  const entry = pending.get(requestId);
  if (entry && messageId) entry.messageId = messageId;
}

export function getApproval(requestId: string): PendingApproval | undefined {
  return pending.get(requestId);
}

/** 决议一个待审批请求。返回被决议的条目，若 id 不存在（已决议/已超时）返回 undefined。 */
export function resolveApproval(
  requestId: string,
  decision: ApprovalDecision,
): PendingApproval | undefined {
  const entry = pending.get(requestId);
  if (!entry) return undefined;
  clearTimeout(entry.timer);
  pending.delete(requestId);
  if (decision === "allow-always") rememberAlways(entry.signature);
  entry.resolve(decision);
  return entry;
}

/** 供人类可读的工具调用摘要，直接进卡片正文。 */
export function describeToolCall(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") {
    const desc = typeof input.description === "string" ? `${input.description}\n\n` : "";
    return `${desc}\`\`\`bash\n${String(input.command ?? "")}\n\`\`\``;
  }
  if (toolName === "Edit" || toolName === "Write") {
    return `**文件**：\`${String(input.file_path ?? "")}\``;
  }
  const json = JSON.stringify(input, null, 2);
  return `\`\`\`json\n${json}\n\`\`\``;
}
