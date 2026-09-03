// 卡点中枢：把 canUseTool 的一次调用，变成飞书上的一张卡片和一个可 resolve 的 Promise。
//
// 两种卡点共用同一张 pending 表、同一套超时与幂等逻辑：
//   - 授权型：Bash / Edit 之类，问的是「允不允许」，收束成三档决策；
//   - 提问型：AskUserQuestion，问的是「你选哪个」，收束成一份 answers 表。
// 差别只在卡片长相和收束方式，plumbing 是同一套，没必要拆成两份。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { ApprovalDecision } from "../feishu/envelope.js";

/** 一个卡点的最终结果。 */
export type PendingOutcome =
  | { kind: "decision"; decision: ApprovalDecision }
  | { kind: "answers"; answers: Record<string, string> };

/** AskUserQuestion 的一问。 */
export type QuestionSpec = {
  question: string;
  header: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
};

export type PendingRequest = {
  requestId: string;
  toolName: string;
  /** 用于 allow-always 匹配的规范化特征 */
  signature: string;
  chatId: string;
  /**
   * 卡点属于哪条会话。必须精确到会话键而不是 chat_id：话题里挂着的提问卡
   * 不该吃掉主群发来的消息，主群开新会话也不该把话题里的卡点一锅端。
   */
  sessionKey: string;
  /** 卡片的 message_id，决议后原地替换 */
  messageId?: string;
  createdAt: number;
  /** 仅提问型：问题清单 */
  questions?: QuestionSpec[];
  /** 仅提问型：与 questions 等长，每问已勾选的选项下标 */
  selections?: number[][];
  /** 仅提问型：用普通消息作答的自由文本，按问题下标存 */
  freeText?: Record<number, string>;
  resolve: (outcome: PendingOutcome) => void;
  timer: NodeJS.Timeout;
};

const pending = new Map<string, PendingRequest>();

// ---------- allow-always 允许列表 ----------

const allowlistPath = path.join(config.dataDir, "allowlist.json");
let allowlist: string[] | null = null;

/**
 * 这些工具永远不进 allow-always。
 *
 * 「总是允许一次提问」没有任何意义：它只会让提问卡再也不出现，
 * 而每一轮都以「用户没作答」收场 —— 正是要修的那个 bug。
 */
const NEVER_REMEMBER = new Set(["AskUserQuestion", "ExitPlanMode"]);

export function isRememberable(toolName: string): boolean {
  return !NEVER_REMEMBER.has(toolName);
}

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

/** 也挡住历史遗留的名单项：名单是文件，可能是老版本写进去的。 */
export function isPreApproved(toolName: string, signature: string): boolean {
  if (!isRememberable(toolName)) return false;
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

export function createPending(params: {
  toolName: string;
  signature: string;
  chatId: string;
  sessionKey: string;
  /** 传入即为提问型卡点 */
  questions?: QuestionSpec[];
  onTimeout: (entry: PendingRequest) => void;
}): { requestId: string; outcome: Promise<PendingOutcome> } {
  const requestId = `req_${crypto.randomBytes(4).toString("hex")}`;

  let resolve!: (outcome: PendingOutcome) => void;
  const outcome = new Promise<PendingOutcome>((r) => {
    resolve = r;
  });

  const timer = setTimeout(() => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    // 超时按拒绝处理 —— 安全默认，绝不能是放行。
    // 提问型同理：宁可让 Claude 知道没人作答，也不能凭空替人选一个。
    entry.resolve({ kind: "decision", decision: "deny" });
    params.onTimeout(entry);
  }, config.approvalTimeoutMs);
  // 别让一个挂起的卡点把进程钉在事件循环里
  timer.unref?.();

  const entry: PendingRequest = {
    requestId,
    toolName: params.toolName,
    signature: params.signature,
    chatId: params.chatId,
    sessionKey: params.sessionKey,
    createdAt: Date.now(),
    ...(params.questions
      ? { questions: params.questions, selections: params.questions.map(() => []) }
      : {}),
    resolve,
    timer,
  };
  pending.set(requestId, entry);

  return { requestId, outcome };
}

export function attachMessageId(requestId: string, messageId: string | undefined): void {
  const entry = pending.get(requestId);
  if (entry && messageId) entry.messageId = messageId;
}

export function getPending(requestId: string): PendingRequest | undefined {
  return pending.get(requestId);
}

/** 决议一个待授权请求。返回被决议的条目，若 id 不存在（已决议/已超时）返回 undefined。 */
export function resolveApproval(
  requestId: string,
  decision: ApprovalDecision,
): PendingRequest | undefined {
  const entry = pending.get(requestId);
  if (!entry) return undefined;
  clearTimeout(entry.timer);
  pending.delete(requestId);
  if (decision === "allow-always" && isRememberable(entry.toolName)) {
    rememberAlways(entry.signature);
  }
  entry.resolve({ kind: "decision", decision });
  return entry;
}

// ---------- 提问型卡点 ----------

/**
 * 从工具入参里解出问题清单。
 *
 * 解不出来就返回 null，调用方退回普通授权卡 —— 宁可显示得笨一点，
 * 也不要因为 SDK 改了 schema 就把一整轮对话卡死在一张画不出来的卡片上。
 */
export function parseQuestions(input: Record<string, unknown>): QuestionSpec[] | null {
  const raw = input.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const specs: QuestionSpec[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const rec = item as Record<string, unknown>;
    const question = typeof rec.question === "string" ? rec.question.trim() : "";
    const rawOptions = Array.isArray(rec.options) ? rec.options : [];
    if (!question || rawOptions.length === 0) return null;

    const options: QuestionSpec["options"] = [];
    for (const opt of rawOptions) {
      if (typeof opt !== "object" || opt === null) return null;
      const o = opt as Record<string, unknown>;
      const label = typeof o.label === "string" ? o.label.trim() : "";
      if (!label) return null;
      options.push({
        label,
        ...(typeof o.description === "string" && o.description.trim()
          ? { description: o.description.trim() }
          : {}),
      });
    }

    specs.push({
      question,
      header: typeof rec.header === "string" && rec.header.trim() ? rec.header.trim() : "选择",
      options,
      multiSelect: rec.multiSelect === true,
    });
  }
  return specs;
}

/** 还有几问没作答。 */
export function unansweredCount(entry: PendingRequest): number {
  return (entry.selections ?? []).filter((picked, i) => picked.length === 0 && !entry.freeText?.[i])
    .length;
}

/**
 * 把勾选状态翻成 SDK 要的 answers 表：问题原文 → 答案。
 * 多选按 SDK 的约定用逗号连接；没作答的问题不出现在表里 —— 不替人编答案。
 */
export function answersOf(entry: PendingRequest): Record<string, string> {
  const answers: Record<string, string> = {};
  entry.questions?.forEach((spec, i) => {
    const free = entry.freeText?.[i];
    if (free) {
      answers[spec.question] = free;
      return;
    }
    const picked = entry.selections?.[i] ?? [];
    if (picked.length === 0) return;
    const labels = picked.map((o) => spec.options[o]?.label).filter((l): l is string => !!l);
    if (labels.length > 0) answers[spec.question] = labels.join(", ");
  });
  return answers;
}

function finish(entry: PendingRequest): void {
  clearTimeout(entry.timer);
  pending.delete(entry.requestId);
  entry.resolve({ kind: "answers", answers: answersOf(entry) });
}

/**
 * 把某个选项设成选中 / 未选中。
 *
 * 注意是「设成」而不是「切换」：飞书会重投卡片回调，切换语义投两次等于没点。
 * submitted 为 true 表示已经就此收束，卡片该换成结果卡了。
 */
export function setOption(
  requestId: string,
  questionIndex: number,
  optionIndex: number,
  selected: boolean,
): { entry: PendingRequest; submitted: boolean } | undefined {
  const entry = pending.get(requestId);
  if (!entry?.questions || !entry.selections) return undefined;
  const spec = entry.questions[questionIndex];
  const picked = entry.selections[questionIndex];
  if (!spec || !picked || !spec.options[optionIndex]) return undefined;

  if (spec.multiSelect) {
    const at = picked.indexOf(optionIndex);
    if (selected && at < 0) picked.push(optionIndex);
    if (!selected && at >= 0) picked.splice(at, 1);
  } else {
    entry.selections[questionIndex] = selected ? [optionIndex] : [];
  }

  // 全单选且都选完了就直接收束：这是最常见的一问一答，再让人补点一次「提交」纯属添堵。
  // 多选必须等确认，否则第一次点击就交卷了。
  if (canAutoSubmit(entry)) {
    finish(entry);
    return { entry, submitted: true };
  }
  return { entry, submitted: false };
}

function canAutoSubmit(entry: PendingRequest): boolean {
  const questions = entry.questions ?? [];
  if (questions.some((q) => q.multiSelect)) return false;
  return unansweredCount(entry) === 0;
}

/** 点「提交」。调用前应确认 unansweredCount 为 0。 */
export function submitAnswers(requestId: string): PendingRequest | undefined {
  const entry = pending.get(requestId);
  if (!entry?.questions) return undefined;
  finish(entry);
  return entry;
}

/** 点「跳过」：清空所有勾选后收束，Claude 那边会收到「没作答」。 */
export function skipQuestion(requestId: string): PendingRequest | undefined {
  const entry = pending.get(requestId);
  if (!entry?.questions) return undefined;
  entry.selections = entry.questions.map(() => []);
  entry.freeText = {};
  finish(entry);
  return entry;
}

/** 这条会话里挂着的提问卡（正常同时只会有一张）。 */
export function findPendingQuestion(sessionKey: string): PendingRequest | undefined {
  let oldest: PendingRequest | undefined;
  for (const entry of pending.values()) {
    if (!entry.questions || entry.sessionKey !== sessionKey) continue;
    if (!oldest || entry.createdAt < oldest.createdAt) oldest = entry;
  }
  return oldest;
}

/**
 * 取消这条会话上所有挂着的卡点。中断、切目录、开新会话时必须调用。
 *
 * 不取消的话它们会一直挂到超时：授权卡停在可点状态却早已无人接收，
 * 提问卡更糟 —— 会把用户的下一条消息当成对一个已经不存在的问题的回答。
 * 顺带也让阻塞在 canUseTool 上的旧 query 能真正走完 dispose。
 * 返回被取消的条目，供调用方把卡片改掉。
 */
export function cancelPending(sessionKey: string): PendingRequest[] {
  const cancelled: PendingRequest[] = [];
  for (const entry of Array.from(pending.values())) {
    if (entry.sessionKey !== sessionKey) continue;
    clearTimeout(entry.timer);
    pending.delete(entry.requestId);
    entry.resolve(
      entry.questions
        ? { kind: "answers", answers: {} }
        : { kind: "decision", decision: "deny" },
    );
    cancelled.push(entry);
  }
  return cancelled;
}

/**
 * 用一条普通消息回答提问卡 —— 等价于官方 UI 里自动附带的 "Other" 自由输入。
 *
 * 提问卡挂着的时候 canUseTool 是阻塞的，消息送进会话也没人接。所以只要还有
 * 没作答的问题，就把这条消息当成其中第一问的自由作答，顺手把轮次解开。
 * 返回 true 表示这条消息已被消费，不该再送进会话。
 */
export function answerWithText(requestId: string, text: string): boolean {
  const entry = pending.get(requestId);
  if (!entry?.questions || !entry.selections) return false;

  const index = entry.selections.findIndex(
    (picked, i) => picked.length === 0 && !entry.freeText?.[i],
  );
  if (index >= 0) (entry.freeText ??= {})[index] = text;
  finish(entry);
  return index >= 0;
}

// ---------- 卡片正文 ----------

/** 供人类可读的工具调用摘要，直接进卡片正文。 */
export function describeToolCall(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") {
    const desc = typeof input.description === "string" ? `${input.description}\n\n` : "";
    return `${desc}\`\`\`bash\n${String(input.command ?? "")}\n\`\`\``;
  }
  if (toolName === "Edit" || toolName === "Write") {
    return `**文件**：\`${String(input.file_path ?? "")}\``;
  }
  // 计划本身就是写给人看的 markdown，套一层 JSON 只会让它没法读
  if (toolName === "ExitPlanMode" && typeof input.plan === "string") {
    return input.plan;
  }
  const json = JSON.stringify(input, null, 2);
  return `\`\`\`json\n${json}\n\`\`\``;
}
