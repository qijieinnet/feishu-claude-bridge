// 卡片按钮里携带的交互信封。
//
// 信任模型（照搬 OpenClaw 的思路，值得写清楚）：信封本身是明文、不签名。
// 它不是凭证，只是「这张卡片期望由谁、在哪、在什么期限前点」的声明。
// 真正的信任锚有两个，都在服务端：
//   1. 飞书回调里的 operator.open_id 由平台签发，客户端伪造不了；
//   2. requestId 必须命中服务端的 pending 表，且点击者要通过授权判断
//      —— 与消息同一套：.env 的 owner 名单，或经终端批准的配对用户。
// 所以信封挡的是「同群别人替你点」「过期后补点」「卡片被转发到别的会话点」，
// 而不是密码学意义的防篡改 —— 后者由飞书平台的事件签发保证。

export const ENVELOPE_VERSION = "fcb1";

export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

// k 是会话键：卡片回调里拿不到 thread_id，不带上它就只能退回 chat 级别的键，
// 在话题里点按钮会操作到群本身的会话上。凡是「作用于某条会话」的动作都得带。
export type EnvelopeAction =
  | { a: "approval"; r: string; d: ApprovalDecision }
  | { a: "model"; m: string; k: string }
  | { a: "resume"; s: string; k: string };

export type CardEnvelope = EnvelopeAction & {
  oc: typeof ENVELOPE_VERSION;
  /** 期望的点击人 open_id */
  u: string;
  /** 期望的会话 chat_id */
  h?: string;
  /** 过期时间戳（ms） */
  e: number;
};

export type DecodeFailure =
  | "malformed"
  | "stale"
  | "wrong_user"
  | "wrong_conversation"
  | "not_allowed";

export type DecodeResult =
  | { ok: true; envelope: CardEnvelope }
  | { ok: false; reason: DecodeFailure };

export function createEnvelope(
  action: EnvelopeAction,
  ctx: { operatorOpenId: string; chatId?: string; expiresAt: number },
): CardEnvelope {
  return {
    oc: ENVELOPE_VERSION,
    ...action,
    u: ctx.operatorOpenId,
    ...(ctx.chatId ? { h: ctx.chatId } : {}),
    e: ctx.expiresAt,
  } as CardEnvelope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeEnvelope(params: {
  value: unknown;
  operatorOpenId: string | undefined;
  chatId: string | undefined;
  isAllowed: (openId: string | undefined) => boolean;
  now?: number;
}): DecodeResult {
  const { value, operatorOpenId, chatId, isAllowed, now = Date.now() } = params;

  if (!isRecord(value) || value.oc !== ENVELOPE_VERSION) {
    return { ok: false, reason: "malformed" };
  }
  if (typeof value.a !== "string" || typeof value.u !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (typeof value.e !== "number" || !Number.isFinite(value.e)) {
    return { ok: false, reason: "malformed" };
  }
  if (value.e < now) {
    return { ok: false, reason: "stale" };
  }

  const operator = operatorOpenId?.trim().toLowerCase();
  if (value.u.trim().toLowerCase() !== operator) {
    return { ok: false, reason: "wrong_user" };
  }
  if (typeof value.h === "string" && value.h.trim() !== (chatId ?? "").trim()) {
    return { ok: false, reason: "wrong_conversation" };
  }
  // 白名单是最后也是最硬的一道：点了不算数，得在名单里。
  if (!isAllowed(operatorOpenId)) {
    return { ok: false, reason: "not_allowed" };
  }

  return { ok: true, envelope: value as CardEnvelope };
}

export const DECODE_FAILURE_TEXT: Record<DecodeFailure, string> = {
  malformed: "这个按钮的数据已损坏，请重新发起操作。",
  stale: "这张卡片已过期，请重新发起操作。",
  wrong_user: "这张卡片不是发给你的，只有发起人本人可以操作。",
  wrong_conversation: "这张卡片属于另一个会话，不能在这里操作。",
  not_allowed: "你不在这台机器的授权名单里。",
};
