// 配置加载与校验：任何缺失的关键项都在启动时炸掉，而不是运行到一半才出问题。
import "dotenv/config";
import path from "node:path";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`缺少环境变量 ${name}，请照 .env.example 填写 .env`);
  }
  return value;
}

function parseAllowFrom(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.startsWith("ou_"));
}

const workspaceRoot = path.resolve(
  process.env.BRIDGE_WORKSPACE_ROOT?.trim() || process.cwd(),
);

export const config = {
  feishu: {
    appId: required("FEISHU_APP_ID"),
    appSecret: required("FEISHU_APP_SECRET"),
  },
  /**
   * 审批人 / 可用者白名单。空数组表示谁都不许用 —— 这是刻意的安全默认：
   * 配错了应该是没人能用，而不是所有人都能用。
   */
  allowFrom: parseAllowFrom(process.env.FEISHU_ALLOW_FROM),
  workspaceRoot,
  approvalTimeoutMs: Number(process.env.BRIDGE_APPROVAL_TIMEOUT_MS ?? 1_800_000),
  /** 会话闲置多久就作废，之后自动开新的。默认 12 小时 */
  sessionTtlMs: Number(process.env.BRIDGE_SESSION_TTL_MS ?? 12 * 60 * 60 * 1000),
  defaultModel: process.env.BRIDGE_DEFAULT_MODEL?.trim() || undefined,
  dataDir: path.join(process.cwd(), "data"),
} as const;

export function isAllowedSender(openId: string | undefined): boolean {
  if (!openId) return false;
  return config.allowFrom.includes(openId.trim().toLowerCase());
}

/** 把用户给的目录限制在 workspaceRoot 之内，防止 /cd 跳到任意路径。 */
export function resolveWorkspacePath(input: string): string | null {
  const target = path.resolve(config.workspaceRoot, input);
  const rel = path.relative(config.workspaceRoot, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return target;
}
