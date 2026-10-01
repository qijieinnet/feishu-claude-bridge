// 飞书消息里的图片 / 文件 / 语音 / 视频：解析、落盘、拼成发给 Claude 的消息。
//
// 所有附件都存到本地，并把路径告诉 Claude —— 它可以用工具去读、去处理。
// 图片和 PDF 额外直接附在消息里，Claude 不用再读一遍就能看到内容。
//
// 文件按会话分目录存，开新会话就整个目录删掉：上传的东西只服务于当前这段对话，
// 留着只会越积越多。放在 bridgeHome 下而不是项目目录里，免得弄脏用户的仓库。
import fs from "node:fs";
import path from "node:path";
import { larkClient } from "./feishu/client.js";
import { config } from "./config.js";
import { getExistingBinding, isSessionExpired } from "./store.js";

export type AttachmentKind = "image" | "file" | "audio" | "video";

/** 消息里引用的一个资源，还没下载。 */
export type AttachmentRef = {
  kind: AttachmentKind;
  /** 下载用的 key：图片是 image_key，其它是 file_key */
  key: string;
  name?: string;
  durationMs?: number;
};

export type ParsedMessage = { text: string; attachments: AttachmentRef[] };

/** 下载落盘之后的附件。 */
export type SavedAttachment = AttachmentRef & {
  path: string;
  size: number;
  mediaType?: string;
};

/** Claude 原生能看的内容块 —— 和 Anthropic API 的 content block 同形。 */
export type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }
  | {
      type: "document";
      source: { type: "base64"; media_type: "application/pdf"; data: string };
    };

/**
 * 直接附进消息的大小上限（原始字节）。
 *
 * API 对单张图片的限制是 5MB，按 base64 后计；PDF 是整个请求 32MB。
 * 超了不硬塞 —— 请求会整轮失败 —— 只给路径，让 Claude 自己决定怎么处理。
 */
const INLINE_IMAGE_MAX = 3.75 * 1024 * 1024;
const INLINE_PDF_MAX = 20 * 1024 * 1024;

export const KIND_LABEL: Record<AttachmentKind, string> = {
  image: "图片",
  file: "文件",
  audio: "语音",
  video: "视频",
};

const UNSUPPORTED_TYPES: Record<string, string> = {
  sticker: "表情包",
  merge_forward: "合并转发",
  interactive: "卡片",
  share_chat: "群名片",
  share_user: "个人名片",
  location: "位置",
  todo: "任务",
  vote: "投票",
};

/**
 * 把飞书消息解析成文字 + 附件引用。
 * 不认识的消息类型返回 null；调用方据此回一句「不支持」。
 */
export function parseMessage(message: {
  message_type?: string;
  content?: string;
}): ParsedMessage | null {
  let content: any;
  try {
    content = JSON.parse(message.content ?? "{}");
  } catch {
    return null;
  }

  switch (message.message_type) {
    case "text":
      return { text: String(content.text ?? ""), attachments: [] };
    case "image":
      return content.image_key
        ? { text: "", attachments: [{ kind: "image", key: content.image_key }] }
        : null;
    case "file":
      return content.file_key
        ? {
            text: "",
            attachments: [{ kind: "file", key: content.file_key, name: content.file_name }],
          }
        : null;
    case "audio":
      return content.file_key
        ? {
            text: "",
            attachments: [
              { kind: "audio", key: content.file_key, durationMs: Number(content.duration) || undefined },
            ],
          }
        : null;
    case "media":
      return content.file_key
        ? {
            text: "",
            attachments: [
              {
                kind: "video",
                key: content.file_key,
                name: content.file_name,
                durationMs: Number(content.duration) || undefined,
              },
            ],
          }
        : null;
    case "post":
      return parsePost(content);
    default:
      return null;
  }
}

export function unsupportedTypeLabel(messageType: string | undefined): string {
  return (messageType && UNSUPPORTED_TYPES[messageType]) ?? "这种";
}

/**
 * 富文本：文字按原顺序拼起来，图片和视频在原位置留个占位，
 * 这样「看第二张图」这种说法还能对得上号。
 */
function parsePost(content: any): ParsedMessage | null {
  // 接收事件里是 {title, content}；个别客户端会包一层语言 {zh_cn: {...}}
  const body =
    Array.isArray(content?.content)
      ? content
      : Object.values(content ?? {}).find((v: any) => Array.isArray(v?.content));
  if (!body) return null;

  const attachments: AttachmentRef[] = [];
  const lines: string[] = [];
  if (body.title) lines.push(String(body.title));

  for (const paragraph of body.content as any[][]) {
    if (!Array.isArray(paragraph)) continue;
    let line = "";
    for (const el of paragraph) {
      switch (el?.tag) {
        case "text":
        case "md":
          line += el.text ?? "";
          break;
        case "a":
          line += el.text && el.href && el.text !== el.href ? `[${el.text}](${el.href})` : (el.href ?? el.text ?? "");
          break;
        case "at":
          // 占位符形如 @_user_1，和纯文本消息一样在后面统一剥掉
          line += el.user_id ?? "";
          break;
        case "code_block":
          line += `\n\`\`\`${el.language ?? ""}\n${el.text ?? ""}\n\`\`\`\n`;
          break;
        case "emotion":
          line += el.emoji_type ? `[${el.emoji_type}]` : "";
          break;
        case "img":
          if (el.image_key) {
            attachments.push({ kind: "image", key: el.image_key });
            line += `[图片${countOf(attachments, "image")}]`;
          }
          break;
        case "media":
          if (el.file_key) {
            attachments.push({ kind: "video", key: el.file_key });
            line += `[视频${countOf(attachments, "video")}]`;
          }
          break;
      }
    }
    lines.push(line);
  }

  return { text: lines.join("\n"), attachments };
}

function countOf(list: AttachmentRef[], kind: AttachmentKind): number {
  return list.filter((a) => a.kind === kind).length;
}

// ---------- 落盘 ----------

const uploadsRoot = path.join(config.dataDir, "uploads");

/** 会话键里有 `:`（话题），编码成能做目录名、又能还原的样子。 */
export function uploadsDirFor(key: string): string {
  return path.join(uploadsRoot, encodeURIComponent(key));
}

/** 建好该会话的上传目录并返回路径。 */
export function ensureUploadsDir(key: string): string {
  const dir = uploadsDirFor(key);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 去掉路径分隔符和控制字符，防止文件名把文件写到目录外面去。 */
function safeName(name: string): string {
  const cleaned = path
    .basename(name)
    .replace(/[\u0000-\u001f/\\]/g, "_")
    .trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned.slice(0, 120) : "file";
}

/** 按文件头判断类型。飞书给的图片没有文件名，扩展名只能靠这个。 */
function sniff(buf: Buffer): { mediaType: string; ext: string } | undefined {
  const hex = buf.subarray(0, 12).toString("hex");
  if (hex.startsWith("89504e47")) return { mediaType: "image/png", ext: "png" };
  if (hex.startsWith("ffd8ff")) return { mediaType: "image/jpeg", ext: "jpg" };
  if (hex.startsWith("47494638")) return { mediaType: "image/gif", ext: "gif" };
  if (hex.startsWith("52494646") && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    return { mediaType: "image/webp", ext: "webp" };
  }
  if (hex.startsWith("25504446")) return { mediaType: "application/pdf", ext: "pdf" };
  if (buf.subarray(0, 4).toString("ascii") === "OggS") return { mediaType: "audio/ogg", ext: "opus" };
  if (buf.subarray(4, 8).toString("ascii") === "ftyp") return { mediaType: "video/mp4", ext: "mp4" };
  return undefined;
}

function defaultName(ref: AttachmentRef, stamp: string, ext: string | undefined): string {
  const base = `${ref.kind}-${stamp}`;
  return ext ? `${base}.${ext}` : base;
}

/** 同名文件不覆盖，加序号。 */
function uniquePath(dir: string, name: string): string {
  let candidate = path.join(dir, name);
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; fs.existsSync(candidate); i++) {
    candidate = path.join(dir, `${stem}-${i}${ext}`);
  }
  return candidate;
}

/**
 * 把消息里的附件下载到该会话的上传目录。
 * 单个失败不影响其它的，失败的原因带回去告诉用户。
 */
export async function saveAttachments(params: {
  key: string;
  messageId: string;
  attachments: AttachmentRef[];
}): Promise<{ saved: SavedAttachment[]; failed: { ref: AttachmentRef; reason: string }[] }> {
  const dir = ensureUploadsDir(params.key);

  const saved: SavedAttachment[] = [];
  const failed: { ref: AttachmentRef; reason: string }[] = [];
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");

  for (const ref of params.attachments) {
    const tmp = path.join(dir, `.download-${process.pid}-${Date.now()}`);
    try {
      const res = await larkClient.im.v1.messageResource.get({
        path: { message_id: params.messageId, file_key: ref.key },
        params: { type: ref.kind === "image" ? "image" : "file" },
      });
      await res.writeFile(tmp);

      const head = Buffer.alloc(12);
      const fd = fs.openSync(tmp, "r");
      fs.readSync(fd, head, 0, 12, 0);
      fs.closeSync(fd);
      const sniffed = sniff(head);

      const name = ref.name ? safeName(ref.name) : defaultName(ref, stamp, sniffed?.ext);
      const target = uniquePath(dir, name);
      fs.renameSync(tmp, target);

      saved.push({
        ...ref,
        path: target,
        size: fs.statSync(target).size,
        ...(sniffed ? { mediaType: sniffed.mediaType } : {}),
      });
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      failed.push({ ref, reason: await describeDownloadError(err) });
    }
  }

  return { saved, failed };
}

/**
 * 下载接口按二进制流请求，出错时响应体也是一个流，
 * 得先读出来再解析，否则永远拿不到飞书的错误码。
 */
async function readErrorBody(err: unknown): Promise<{ code?: number; msg?: string } | undefined> {
  const raw = (err as { response?: { data?: unknown } })?.response?.data;
  if (!raw) return undefined;
  if (typeof (raw as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") {
    return raw as { code?: number; msg?: string };
  }
  try {
    let body = "";
    for await (const chunk of raw as AsyncIterable<Buffer | string>) body += chunk.toString();
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

async function describeDownloadError(err: unknown): Promise<string> {
  const data = await readErrorBody(err);
  // 99991672：应用没开对应权限
  if (data?.code === 99991672) {
    return "飞书应用缺少「获取与上传图片或文件资源」(im:resource) 权限";
  }
  if (data) return `飞书返回 code=${data.code} ${(data.msg ?? "").slice(0, 120)}`.trim();
  return err instanceof Error ? err.message : String(err);
}

// ---------- 拼消息 ----------

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function canInline(a: SavedAttachment): boolean {
  if (a.mediaType === "application/pdf") return a.size <= INLINE_PDF_MAX;
  if (a.mediaType?.startsWith("image/")) return a.size <= INLINE_IMAGE_MAX;
  return false;
}

/**
 * 拼成送进会话的内容：一段说明文字（用户的话 + 附件清单），后面跟着能直接看的图片和 PDF。
 * 没有附件时就是原样的文字，和以前完全一样。
 */
export function buildContent(text: string, saved: SavedAttachment[]): string | ContentBlock[] {
  if (saved.length === 0) return text;

  // 按类型编号，和富文本里留的 [图片2] 这类占位对得上
  const counters: Partial<Record<AttachmentKind, number>> = {};
  const lines = saved.map((a) => {
    const n = (counters[a.kind] = (counters[a.kind] ?? 0) + 1);
    const details = [
      formatSize(a.size),
      ...(a.durationMs ? [`时长 ${Math.round(a.durationMs / 1000)} 秒`] : []),
      ...(canInline(a) ? ["内容已附在本消息中"] : []),
    ];
    return `- ${KIND_LABEL[a.kind]}${n}：${a.path}（${details.join("，")}）`;
  });

  const note = [
    "[用户通过飞书发来了以下附件，已保存到本地，需要时可以直接读取或处理这些文件]",
    ...lines,
  ].join("\n");

  const blocks: ContentBlock[] = [{ type: "text", text: text ? `${text}\n\n${note}` : note }];
  for (const a of saved) {
    if (!canInline(a)) continue;
    const data = fs.readFileSync(a.path).toString("base64");
    blocks.push(
      a.mediaType === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
        : { type: "image", source: { type: "base64", media_type: a.mediaType!, data } },
    );
  }
  return blocks;
}

// ---------- 清理 ----------

/** 开新会话时调用：上一段对话的附件不再需要。 */
export function clearUploads(key: string): void {
  try {
    fs.rmSync(uploadsDirFor(key), { recursive: true, force: true });
  } catch (err) {
    console.warn(`[附件] 清理 ${key} 的上传目录失败:`, err);
  }
}

/**
 * 启动时扫一遍：会话已经没了或已过期的，目录一并删掉。
 * 防的是进程崩溃、或会话在桥接器没跑的时候过期，导致目录没人清。
 */
export function sweepUploads(): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(uploadsRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    let key: string;
    try {
      key = decodeURIComponent(entry);
    } catch {
      continue;
    }
    const binding = getExistingBinding(key);
    if (binding?.sessionId && !isSessionExpired(binding)) continue;
    fs.rmSync(path.join(uploadsRoot, entry), { recursive: true, force: true });
    console.log(`[附件] 已清理过期会话 ${key} 的上传目录`);
  }
}
