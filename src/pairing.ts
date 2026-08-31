// 配对：陌生人给机器人发消息时拿到一个短码，消息本身不被处理；
// 你在终端 approve 之后他才能用。替代手工抄 open_id。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./home.js";

/** 去掉 0/O/1/I，避免念错抄错 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const CODE_TTL_MS = 60 * 60 * 1000;
/** 同时最多挂 3 个待批请求，超出的直接忽略，防止陌生人刷屏 */
const MAX_PENDING = 3;

export type PairRequest = {
  code: string;
  openId: string;
  chatId: string;
  name?: string;
  createdAt: number;
};

type PairStore = {
  pending: PairRequest[];
  approved: string[];
};

const storePath = path.join(dataDir, "pairing.json");

function read(): PairStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as Partial<PairStore>;
    return { pending: parsed.pending ?? [], approved: parsed.approved ?? [] };
  } catch {
    return { pending: [], approved: [] };
  }
}

function write(store: PairStore): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function fresh(store: PairStore, now = Date.now()): PairStore {
  return { ...store, pending: store.pending.filter((p) => now - p.createdAt < CODE_TTL_MS) };
}

function newCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/** 该 open_id 是否已被批准过 */
export function isPaired(openId: string | undefined): boolean {
  if (!openId) return false;
  return read().approved.includes(openId.trim().toLowerCase());
}

export type PairOutcome =
  | { kind: "already_pending"; request: PairRequest }
  | { kind: "created"; request: PairRequest }
  | { kind: "rejected_full" };

/**
 * 为陌生发送者登记一次配对请求。
 * 同一个人在码有效期内重复发消息不会反复生成新码，也就不会反复回他消息。
 */
export function requestPairing(params: {
  openId: string;
  chatId: string;
  name?: string;
}): PairOutcome {
  const store = fresh(read());
  const openId = params.openId.trim().toLowerCase();

  const existing = store.pending.find((p) => p.openId === openId);
  if (existing) {
    write(store);
    return { kind: "already_pending", request: existing };
  }

  if (store.pending.length >= MAX_PENDING) {
    write(store);
    return { kind: "rejected_full" };
  }

  const request: PairRequest = {
    code: newCode(),
    openId,
    chatId: params.chatId,
    ...(params.name ? { name: params.name } : {}),
    createdAt: Date.now(),
  };
  store.pending.push(request);
  write(store);
  return { kind: "created", request };
}

export function listPending(): PairRequest[] {
  const store = fresh(read());
  write(store);
  return store.pending;
}

export type ApproveResult =
  | { ok: true; request: PairRequest }
  | { ok: false; reason: "not_found" };

export function approve(code: string): ApproveResult {
  const store = fresh(read());
  const normalized = code.trim().toUpperCase();
  const index = store.pending.findIndex((p) => p.code === normalized);
  if (index === -1) return { ok: false, reason: "not_found" };

  const [request] = store.pending.splice(index, 1);
  if (!request) return { ok: false, reason: "not_found" };
  if (!store.approved.includes(request.openId)) store.approved.push(request.openId);
  write(store);
  return { ok: true, request };
}

export function revoke(openId: string): boolean {
  const store = fresh(read());
  const normalized = openId.trim().toLowerCase();
  const next = store.approved.filter((id) => id !== normalized);
  const changed = next.length !== store.approved.length;
  store.approved = next;
  write(store);
  return changed;
}

export function listApproved(): string[] {
  return read().approved;
}

/** 监听配对文件变化，用于批准后立刻通知等待中的人。 */
export function watchPairing(onChange: () => void): fs.FSWatcher | undefined {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(storePath)) write({ pending: [], approved: [] });
    return fs.watch(storePath, { persistent: false }, () => onChange());
  } catch {
    return undefined;
  }
}
