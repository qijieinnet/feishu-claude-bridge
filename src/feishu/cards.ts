// 卡片构造，全部使用 JSON 2.0。
//
// 2.0 与 1.0 的三处硬差异（踩过坑，别改回去）：
//   1. 没有 `tag: "action"` 容器，按钮直接作为 element；横排要用 column_set 包 column
//   2. 回调数据不再是按钮的 `value` 字段，而是 behaviors: [{ type: "callback", value }]
//   3. 没有 `tag: "note"`，小字提示只能并进 markdown
// 回调值仍然出现在事件的 action.value 上，所以信封解码那侧不受影响。
import { createEnvelope, type CardEnvelope, type EnvelopeAction } from "./envelope.js";
import type { QuestionSpec } from "../claude/approvals.js";

type Ctx = { operatorOpenId: string; chatId?: string; expiresAt: number };

function button(
  label: string,
  action: EnvelopeAction,
  ctx: Ctx,
  type: "default" | "primary" | "danger" = "default",
) {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    behaviors: [
      { type: "callback", value: createEnvelope(action, ctx) satisfies CardEnvelope },
    ],
  };
}

/** 把若干按钮横向排成一行。 */
function buttonRow(buttons: ReturnType<typeof button>[]) {
  return {
    tag: "column_set",
    flex_mode: "flow",
    horizontal_spacing: "8px",
    columns: buttons.map((b) => ({
      tag: "column",
      width: "auto",
      elements: [b],
    })),
  };
}

/** 截断过长的文本，避免卡片超限；保留头尾更利于判断。 */
export function clip(text: string, max = 1500): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.7));
  const tail = text.slice(-Math.floor(max * 0.2));
  return `${head}\n\n… (省略 ${text.length - head.length - tail.length} 字) …\n\n${tail}`;
}

// update_multi 必须显式为 true：更新卡片接口要求更新前后的 config 都声明它。
// 2.0 文档说默认即为 true，但两份文档口径不一致，显式写上没有坏处。
const baseConfig = { width_mode: "fill", update_multi: true };

/**
 * 审批卡：三档决策。
 * requestId 显式印在正文里，这样卡片失效时还能手打 /approve <id> allow-once 兜底。
 */
export function approvalCard(params: {
  requestId: string;
  toolName: string;
  detail: string;
  /** 为 false 时不给「总是允许」—— 有些工具记住了就等于以后再也不问 */
  rememberable?: boolean;
  ctx: Ctx;
}) {
  const { requestId, toolName, detail, ctx } = params;
  // ExitPlanMode 问的其实是「这个计划行不行」，照着工具名印「需要授权」很误导
  const title =
    toolName === "ExitPlanMode" ? "Claude 想按这个计划动手" : `需要授权：${toolName}`;
  const buttons = [
    button("允许一次", { a: "approval", r: requestId, d: "allow-once" }, ctx, "primary"),
    ...(params.rememberable === false
      ? []
      : [button("总是允许", { a: "approval", r: requestId, d: "allow-always" }, ctx)]),
    button("拒绝", { a: "approval", r: requestId, d: "deny" }, ctx, "danger"),
  ];
  return {
    schema: "2.0",
    config: baseConfig,
    header: {
      title: { tag: "plain_text", content: title },
      template: "orange",
    },
    body: {
      elements: [
        { tag: "markdown", content: clip(detail) },
        { tag: "hr" },
        buttonRow(buttons),
        {
          tag: "markdown",
          content: `请求 \`${requestId}\`　按钮失效时可发送：\`/approve ${requestId} allow-once\``,
        },
      ],
    },
  };
}

/** 审批结果卡：点完之后把原卡片替换掉，避免重复点击和状态歧义。 */
export function approvalResolvedCard(params: {
  requestId: string;
  toolName: string;
  decision: string;
  by: string;
}) {
  const settled =
    params.decision === "deny" ||
    params.decision === "timeout" ||
    params.decision === "cancelled";
  const label =
    params.decision === "allow-once"
      ? "已允许（本次）"
      : params.decision === "allow-always"
        ? "已允许（后续同类自动放行）"
        : params.decision === "timeout"
          ? "已超时，按拒绝处理"
          : params.decision === "cancelled"
            ? "已取消"
            : "已拒绝";
  return {
    schema: "2.0",
    config: baseConfig,
    header: {
      title: { tag: "plain_text", content: `${label}：${params.toolName}` },
      template: settled ? "grey" : "green",
    },
    body: {
      elements: [
        { tag: "markdown", content: `请求 \`${params.requestId}\`　${params.by}` },
      ],
    },
  };
}

/**
 * 提问卡：Claude 给了几个选项，让人在飞书上真的能点。
 *
 * 这张卡是有状态的 —— 每点一下就用最新的勾选重渲一次，所以它同时也是
 * 「已经选了什么」的显示器。全单选且都选完会自动收束，多选要点「提交」。
 */
export function questionCard(params: {
  requestId: string;
  questions: QuestionSpec[];
  selections: number[][];
  ctx: Ctx;
}) {
  const { requestId, questions, selections, ctx } = params;
  const needsSubmit = questions.some((q) => q.multiSelect);
  const elements: unknown[] = [];

  questions.forEach((spec, qi) => {
    if (qi > 0) elements.push({ tag: "hr" });
    const picked = selections[qi] ?? [];
    elements.push({
      tag: "markdown",
      content: `**${spec.header}**　${spec.question}${spec.multiSelect ? "（可多选）" : ""}`,
    });
    elements.push(
      buttonRow(
        spec.options.map((opt, oi) => {
          const on = picked.includes(oi);
          // 单选的按钮永远是「选中我」；多选的按钮带着当前状态的反面，点一下即翻面
          const next: 0 | 1 = spec.multiSelect && on ? 0 : 1;
          return button(
            `${on ? "✅ " : ""}${clip(opt.label, 30)}`,
            { a: "ask", r: requestId, q: qi, o: oi, v: next },
            ctx,
            on ? "primary" : "default",
          );
        }),
      ),
    );
    const notes = spec.options
      .filter((opt) => opt.description)
      .map((opt) => `**${opt.label}** — ${opt.description}`)
      .join("\n");
    if (notes) elements.push({ tag: "markdown", content: clip(notes, 800) });
  });

  elements.push({ tag: "hr" });
  elements.push(
    buttonRow([
      ...(needsSubmit
        ? [button("提交", { a: "ask-submit", r: requestId }, ctx, "primary")]
        : []),
      button("跳过", { a: "ask-skip", r: requestId }, ctx),
    ]),
  );
  elements.push({
    tag: "markdown",
    content: "选项都不合适？**直接发一条消息**就当作你的回答。",
  });

  return {
    schema: "2.0",
    config: baseConfig,
    header: { title: { tag: "plain_text", content: "Claude 想确认一下" }, template: "violet" },
    body: { elements },
  };
}

/** 提问结果卡：作答后原地替换，避免重复点击和状态歧义。 */
export function questionResolvedCard(params: {
  questions: QuestionSpec[];
  answers: Record<string, string>;
  /** 收束方式的说明，例如「已超时」「已跳过」 */
  note?: string;
}) {
  const answered = params.questions.filter((spec) => params.answers[spec.question]);
  const lines = answered.map(
    (spec) => `**${spec.header}**　${spec.question}\n→ ${params.answers[spec.question]}`,
  );
  const empty = answered.length === 0;

  return {
    schema: "2.0",
    config: baseConfig,
    header: {
      title: { tag: "plain_text", content: empty ? "未作答" : "已回答" },
      template: empty ? "grey" : "green",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: clip(
            empty ? params.note ?? "没有选择任何选项。" : lines.join("\n\n"),
            2000,
          ),
        },
        ...(params.note && !empty ? [{ tag: "markdown", content: params.note }] : []),
      ],
    },
  };
}

/** 模型选择卡：模型列表由 SDK 的 supportedModels() 提供，不写死。 */
export function modelPickerCard(params: {
  models: { model: string; displayName?: string; description?: string }[];
  current?: string;
  sessionKey: string;
  ctx: Ctx;
}) {
  const buttons = params.models
    .slice(0, 10)
    .map((m) =>
      button(
        `${m.displayName ?? m.model}${m.model === params.current ? " ✅" : ""}`,
        { a: "model", m: m.model, k: params.sessionKey },
        params.ctx,
      ),
    );
  return {
    schema: "2.0",
    config: baseConfig,
    header: { title: { tag: "plain_text", content: "切换模型" }, template: "blue" },
    body: {
      elements: [
        {
          tag: "markdown",
          content: params.current ? `当前：**${params.current}**` : "当前：默认模型",
        },
        { tag: "hr" },
        buttonRow(buttons),
      ],
    },
  };
}

/**
 * 过程卡：实时显示思考与工具调用。
 *
 * 进行中展开，让人看得到进度；完成后折叠成一行摘要，不再占据聊天空间
 * ——过程是过程，看完就该收起来。
 */
export function progressCard(params: { steps: string[]; done?: boolean; footer?: string }) {
  const body = clip(params.steps.length > 0 ? params.steps.join("\n") : "…", 2000);

  if (!params.done) {
    return {
      schema: "2.0",
      config: baseConfig,
      body: { elements: [{ tag: "markdown", content: body }] },
    };
  }

  const summary = `已完成 ${params.steps.length} 步${params.footer ? `　${params.footer}` : ""}`;
  return {
    schema: "2.0",
    config: baseConfig,
    body: {
      elements: [
        {
          tag: "collapsible_panel",
          expanded: false,
          header: {
            title: { tag: "plain_text", content: summary },
            vertical_align: "center",
            icon: {
              tag: "standard_icon",
              token: "down-small-ccm_outlined",
              size: "16px 16px",
            },
          },
          padding: "8px 8px 8px 8px",
          elements: [{ tag: "markdown", content: body }],
        },
      ],
    },
  };
}

/**
 * 回复卡：最终答案。
 *
 * 飞书的纯文本消息不渲染 markdown，标题、列表、代码块都会变成原始符号，
 * 所以回复必须走卡片。这张卡刻意做到最简 —— 没有标题栏、没有按钮，
 * 只有正文，看起来尽量接近一条普通消息。
 */
export function replyCard(text: string) {
  return {
    schema: "2.0",
    config: baseConfig,
    body: { elements: [{ tag: "markdown", content: clip(text, 4000) }] },
  };
}

/**
 * 历史会话卡：列出当前目录下最近的会话，点按钮直接 resume。
 *
 * 会话键随信封一起带走 —— 卡片回调里没有 thread_id，不带就没法区分
 * 「群里的话题会话」和「群本身的会话」。
 */
export function sessionListCard(params: {
  sessions: { sessionId: string; title: string; updatedAt: number }[];
  current?: string;
  cwd: string;
  sessionKey: string;
  ctx: Ctx;
}) {
  const elements: unknown[] = [
    { tag: "markdown", content: `目录 \`${params.cwd}\`` },
  ];

  params.sessions.forEach((entry, index) => {
    const isCurrent = entry.sessionId === params.current;
    elements.push({ tag: "hr" });
    elements.push({
      tag: "markdown",
      content:
        `**${index + 1}. ${entry.title}**${isCurrent ? "　✅ 当前" : ""}\n` +
        `\`${entry.sessionId}\`　${relativeTime(entry.updatedAt)}`,
    });
    if (!isCurrent) {
      elements.push(
        buttonRow([
          button(
            "恢复这条",
            { a: "resume", s: entry.sessionId, k: params.sessionKey },
            params.ctx,
          ),
        ]),
      );
    }
  });

  return {
    schema: "2.0",
    config: baseConfig,
    header: { title: { tag: "plain_text", content: "历史会话" }, template: "blue" },
    body: { elements },
  };
}

function relativeTime(ts: number, now = Date.now()): string {
  const minutes = Math.floor((now - ts) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN");
}
