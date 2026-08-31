// 把 SDK / CLI 抛出的原始错误翻译成人能看懂、且知道下一步做什么的提示。
//
// 原则：飞书上给一句人话 + 一条明确动作；终端给完整修复步骤。
// 不要把 SDK 堆栈直接甩给用户 —— 那既吓人又没有信息量。

export type DiagnosisKind =
  | "auth_expired"
  | "auth_missing"
  | "cli_missing"
  | "rate_limit"
  | "billing"
  | "unknown";

export type Diagnosis = {
  kind: DiagnosisKind;
  /** 发到飞书的简短说明 */
  chatMessage: string;
  /** 打在终端的修复步骤 */
  consoleHint: string;
  /** 是否属于「配置好之前重试也没用」的问题 */
  fatal: boolean;
};

const LOGIN_STEPS = [
  "  1) npm i -g @anthropic-ai/claude-code",
  "  2) claude          # 然后用 /login 登录",
  '  3) claude -p "回复 OK"   # 验证认证是否恢复',
  "  4) 重启桥接器：npm start",
].join("\n");

export function diagnose(err: unknown): Diagnosis {
  const raw = err instanceof Error ? err.message : String(err);
  const text = raw.toLowerCase();

  if (
    text.includes("oauth session expired") ||
    text.includes("could not be refreshed") ||
    text.includes("failed to authenticate")
  ) {
    return {
      kind: "auth_expired",
      chatMessage:
        "Claude 的登录状态已过期，我暂时无法工作。\n请机器主人在终端重新登录（`claude` → `/login`），完成后我就能继续。",
      consoleHint: `Claude Code 登录已过期，需要重新登录：\n${LOGIN_STEPS}`,
      fatal: true,
    };
  }

  if (
    text.includes("invalid api key") ||
    text.includes("authentication_error") ||
    text.includes("unauthorized")
  ) {
    return {
      kind: "auth_missing",
      chatMessage:
        "Claude 的凭证无效，我暂时无法工作。\n请机器主人检查登录状态或 ANTHROPIC_API_KEY。",
      consoleHint: `Claude 凭证无效。若用订阅账号，重新登录：\n${LOGIN_STEPS}\n若用 API key，检查 ANTHROPIC_API_KEY 是否正确。`,
      fatal: true,
    };
  }

  if (
    text.includes("enoent") ||
    text.includes("command not found") ||
    text.includes("spawn") ||
    text.includes("could not find claude")
  ) {
    return {
      kind: "cli_missing",
      chatMessage:
        "本机还没装好 Claude Code，我暂时无法工作。\n请机器主人先完成安装。",
      consoleHint: `找不到可用的 Claude Code。安装并登录：\n${LOGIN_STEPS}`,
      fatal: true,
    };
  }

  if (text.includes("rate limit") || text.includes("usage limit")) {
    return {
      kind: "rate_limit",
      chatMessage: "Claude 的用量已达上限，请稍后再试。",
      consoleHint: "已达用量上限。等配额恢复，或换用额度更充足的账号 / API key。",
      fatal: false,
    };
  }

  if (text.includes("credit balance") || text.includes("billing")) {
    return {
      kind: "billing",
      chatMessage: "Claude 账户余额不足，请机器主人处理后再试。",
      consoleHint: "账户余额不足，请到 Claude 控制台充值或检查订阅状态。",
      fatal: false,
    };
  }

  return {
    kind: "unknown",
    // 未知错误才把原文带给用户 —— 有原文总比一句「出错了」强
    chatMessage: `出错了：${raw}`,
    consoleHint: raw,
    fatal: false,
  };
}

/** 同一类问题只在终端刷一次完整指引，避免每条消息都刷屏 */
const announced = new Set<DiagnosisKind>();

export function announceOnce(diagnosis: Diagnosis): void {
  if (diagnosis.kind === "unknown" || !announced.has(diagnosis.kind)) {
    const line = "─".repeat(56);
    console.error(`\n${line}\n${diagnosis.consoleHint}\n${line}\n`);
    announced.add(diagnosis.kind);
  } else {
    console.error(`[claude] ${diagnosis.kind}（指引见上文）`);
  }
}

export function resetAnnouncements(): void {
  announced.clear();
}
