// 会话映射的持久化：飞书会话 → Claude sessionId / 工作目录 / 模型。
// 用一个 JSON 文件，够用且好排查；量大了再换 SQLite 不迟。
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export type BoundSession = {
  /** Claude 的 session id，用于 resume / fork */
  sessionId?: string;
  /** 该会话绑定的工作目录 */
  cwd: string;
  /**
   * cwd 是否为用户用 /cd 显式指定的。
   * 未显式指定的会话，其 cwd 只是默认继承自配置，应当跟随 BRIDGE_WORKSPACE_ROOT 变化，
   * 否则改了配置也会被持久化的旧默认值一直盖住。
   */
  cwdExplicit?: boolean;
  /** 该会话选定的模型，undefined = 用默认 */
  model?: string;
  updatedAt: number;
};

type StoreShape = Record<string, BoundSession>;

const storePath = path.join(config.dataDir, "sessions.json");
let cache: StoreShape | null = null;

function load(): StoreShape {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(storePath, "utf8")) as StoreShape;
  } catch {
    cache = {};
  }
  return cache;
}

function persist(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(cache ?? {}, null, 2));
}

/**
 * 会话键：优先用话题 thread_id，退回 chat_id。
 * 这样「一个话题 = 一个独立会话」，同一个群里可以并行跑多个任务。
 */
export function sessionKey(params: { chatId: string; threadId?: string }): string {
  return params.threadId ? `${params.chatId}:${params.threadId}` : params.chatId;
}

export function getBinding(key: string): BoundSession {
  const store = load();
  const existing = store[key];
  if (existing) {
    const rel = path.relative(config.workspaceRoot, existing.cwd);
    const inside =
      existing.cwd === config.workspaceRoot ||
      (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel));

    // 显式指定过的目录尊重用户选择，只在越界时回退；
    // 没指定过的只是默认值，必须跟随当前配置。
    const needsReset = existing.cwdExplicit
      ? !inside
      : existing.cwd !== config.workspaceRoot;
    if (!needsReset) return existing;

    const corrected: BoundSession = {
      ...existing,
      cwd: config.workspaceRoot,
      // 目录变了，旧会话的上下文已经没意义，一并丢弃
      sessionId: undefined,
      updatedAt: Date.now(),
    };
    store[key] = corrected;
    persist();
    console.warn(
      `[store] 会话 ${key} 的工作目录由 ${existing.cwd} 重置为 ${config.workspaceRoot}`,
    );
    return corrected;
  }
  const created: BoundSession = { cwd: config.workspaceRoot, updatedAt: Date.now() };
  store[key] = created;
  persist();
  return created;
}

export function updateBinding(key: string, patch: Partial<BoundSession>): BoundSession {
  const store = load();
  const next: BoundSession = { ...getBinding(key), ...patch, updatedAt: Date.now() };
  store[key] = next;
  persist();
  return next;
}

/** 开新会话：丢掉 sessionId，保留 cwd 和模型偏好。 */
export function resetSession(key: string): BoundSession {
  return updateBinding(key, { sessionId: undefined });
}

/** 会话是否已闲置超时。超时的会话不再续用，下次说话自动开新的。 */
export function isSessionExpired(binding: BoundSession, now = Date.now()): boolean {
  return now - binding.updatedAt > config.sessionTtlMs;
}

/** 有活动就续期，避免正在用的会话被判过期。 */
export function touchBinding(key: string): void {
  updateBinding(key, {});
}
