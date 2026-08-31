// 读取 Claude Code 的本地历史会话。
//
// 会话记录是 JSONL，落在 ~/.claude/projects/<编码后的 cwd>/<sessionId>.jsonl，
// 目录名的规则是把 cwd 里所有非字母数字字符换成 '-'
// （/Users/a/.ao/x → -Users-a--ao-x）。这是 CLI 的内部约定、没有公开 API，
// 所以这里所有的 IO 都吞掉异常：读不到就当没有历史，不能让桥接器挂掉。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export type SessionSummary = {
  sessionId: string;
  /** 会话标题：优先用 CLI 记的 custom-title，否则退回第一条用户消息 */
  title: string;
  /** 文件 mtime，即最后活动时间 */
  updatedAt: number;
};

/** 只读文件头：标题一定在最前面，而后面可能跟着几 MB 的 base64 附件。 */
const HEAD_BYTES = 512 * 1024;
/** 超过这个长度的行必然是附件，parse 它纯属浪费 CPU */
const MAX_LINE = 64 * 1024;
const MAX_LINES = 400;

/** sessionId 会被拼进路径，必须先验形，否则 /resume ../../x 就能越界读文件。 */
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;

function claudeHome(): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  return override || path.join(os.homedir(), ".claude");
}

/** cwd → 存放该项目会话记录的目录。 */
export function projectDir(cwd: string): string {
  const encoded = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(claudeHome(), "projects", encoded);
}

/** 指定会话在该目录下是否真的存在。/resume 之前先问这里，别等发消息才炸。 */
export function sessionExists(cwd: string, sessionId: string): boolean {
  if (!SESSION_ID.test(sessionId)) return false;
  try {
    return fs.statSync(path.join(projectDir(cwd), `${sessionId}.jsonl`)).isFile();
  } catch {
    return false;
  }
}

/** 按最后活动时间倒序列出该目录下的历史会话。 */
export async function listSessions(cwd: string, limit = 8): Promise<SessionSummary[]> {
  const dir = projectDir(cwd);

  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }

  const files = names
    .map((name) => {
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size === 0) return null;
        return { sessionId: name.slice(0, -".jsonl".length), file, updatedAt: stat.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { sessionId: string; file: string; updatedAt: number } =>
      entry !== null,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);

  return Promise.all(
    files.map(async (entry) => ({
      sessionId: entry.sessionId,
      title: (await readTitle(entry.file)) ?? "(无标题)",
      updatedAt: entry.updatedAt,
    })),
  );
}

/** 从文件头里找一个能给人看的标题。 */
async function readTitle(file: string): Promise<string | undefined> {
  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(file, { encoding: "utf8", start: 0, end: HEAD_BYTES });
  } catch {
    return undefined;
  }

  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let fallback: string | undefined;
  let seen = 0;

  try {
    for await (const line of lines) {
      if (++seen > MAX_LINES) break;
      if (line.length < 2 || line.length > MAX_LINE) continue;

      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        // 截断的尾行、附件碎片，跳过就是
        continue;
      }

      const record = row as Record<string, any>;
      if (record?.type === "custom-title" && typeof record.customTitle === "string") {
        const title = clean(record.customTitle);
        if (title) return title;
      }
      if (!fallback) {
        const text = firstUserText(record);
        if (text) fallback = text;
      }
    }
  } catch {
    // 读坏了就用已经拿到的
  } finally {
    lines.close();
    stream.destroy();
  }

  return fallback;
}

/** 取第一条真人说的话；工具结果、系统注入的上下文都不算。 */
function firstUserText(record: Record<string, any> | null): string | undefined {
  if (!record || record.type !== "user" || record.isMeta) return undefined;
  const content = record.message?.content;

  if (typeof content === "string") return clean(content);
  if (!Array.isArray(content)) return undefined;

  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      const text = clean(block.text);
      if (text) return text;
    }
  }
  return undefined;
}

function clean(raw: string, max = 60): string {
  // 反引号会打乱卡片里的 markdown；命令与系统提示的包裹标签对人没意义
  const text = raw
    .replace(/<[^>]{1,40}>/g, " ")
    .replace(/`/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
