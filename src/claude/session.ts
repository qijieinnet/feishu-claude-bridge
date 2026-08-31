// 一个飞书会话 ↔ 一个常驻的 Claude query。
//
// 必须用「流式输入」模式：setModel / setPermissionMode / interrupt / supportedModels
// 这些控制方法在 SDK 里全都标注了 Only available in streaming input mode，
// 也就是 prompt 必须是 async iterable，不能是字符串。这是架构前提，别改。
import { query, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";

/** 可以从外部 push 的异步队列，用作 streaming input 的来源。 */
class AsyncQueue<T> {
  private items: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  async *stream(): AsyncGenerator<T> {
    while (true) {
      const item = this.items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiting.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

export type SessionEvents = {
  /** 思考片段或工具调用等过程信息，用于实时展示在过程卡里 */
  onStep: (step: string) => void;
  /** Claude 输出的一段回复文本 */
  onText: (text: string) => void;
  /** 一轮结束 */
  onResult: (summary: { text: string; costUsd: number; durationMs: number }) => void;
  onError: (err: unknown) => void;
  /** 拿到/更新了 session id，用于持久化以便日后 resume */
  onSessionId: (sessionId: string) => void;
};

export type ApprovalBridge = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<PermissionResult>;

export type SessionOptions = {
  cwd: string;
  model?: string;
  /** 传入则 resume 该会话；配合 fork=true 则从它分叉出新会话 */
  resumeSessionId?: string;
  fork?: boolean;
};

export class ClaudeSession {
  private queue = new AsyncQueue<SDKUserMessage>();
  private q: Query | null = null;
  private pump: Promise<void> | null = null;
  private sessionId: string | undefined;
  /** 是否已经拉起过 query。用来区分首次启动和崩溃后的重启。 */
  private everStarted = false;

  constructor(
    private readonly opts: SessionOptions,
    private readonly events: SessionEvents,
    private readonly approvalBridge: ApprovalBridge,
  ) {}

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  private start(): void {
    if (this.q) return;

    // 重启时要接着最新的会话，而不是构造时那个 —— 否则中途崩一次，
    // 之后所有对话都被倒回到最初 resume 的那个点上。
    const resume = this.sessionId ?? this.opts.resumeSessionId;
    // fork 只在第一次生效：重启再 fork 一次就又分叉一条，刚才那轮白丢。
    const fork = this.opts.fork && !this.everStarted;
    this.everStarted = true;

    this.q = query({
      prompt: this.queue.stream(),
      options: {
        cwd: this.opts.cwd,
        // 必须是 default：设成 bypassPermissions 会让 canUseTool 变成死代码，
        // 权限流程在到达回调之前就放行了。
        permissionMode: "default",
        ...(this.opts.model ? { model: this.opts.model } : {}),
        ...(resume ? { resume } : {}),
        ...(fork ? { forkSession: true } : {}),
        canUseTool: async (toolName, input) =>
          this.approvalBridge(toolName, input as Record<string, unknown>),
      },
    });

    this.pump = this.consume()
      .catch((err) => this.events.onError(err))
      .finally(() => {
        // 走到这里说明 query 真的结束了 —— CLI 进程退出，或流式输入被关掉。
        // 正常聊天时它是常驻的，一轮结束并不会走到这。
        //
        // 不清空的话，上面那句 `if (this.q) return` 会一直以为它还活着，
        // 之后每条消息都被 push 进一个没有消费者的队列：会话表面还在，
        // 实际上再也不回话，连"正在输入"都撤不掉。清掉之后，下一条消息
        // 会带着最新的 sessionId 重新拉起来，上下文不丢。
        this.q = null;
        this.pump = null;
      });
  }

  private async consume(): Promise<void> {
    if (!this.q) return;
    for await (const message of this.q as AsyncIterable<SDKMessage>) {
      this.handleMessage(message);
    }
  }

  private handleMessage(message: SDKMessage): void {
    if ("session_id" in message && typeof message.session_id === "string") {
      if (message.session_id !== this.sessionId) {
        this.sessionId = message.session_id;
        this.events.onSessionId(message.session_id);
      }
    }

    if (message.type === "assistant") {
      const blocks = message.message.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          // 思考与工具调用属于「过程」，走过程卡；text 才是要给人看的回复
          if (block.type === "thinking") {
            const thought = summarize(block.thinking);
            if (thought) this.events.onStep(`💭 ${thought}`);
          } else if (block.type === "tool_use") {
            this.events.onStep(`🔧 ${describeToolUse(block.name, block.input)}`);
          } else if (block.type === "text" && block.text.trim()) {
            this.events.onText(block.text);
          }
        }
      }
      return;
    }

    if (message.type === "result") {
      if (message.subtype === "success") {
        this.events.onResult({
          text: message.result,
          costUsd: message.total_cost_usd,
          durationMs: message.duration_ms,
        });
      } else {
        this.events.onError(new Error(`运行结束但报错：${message.subtype}`));
      }
    }
  }

  /** 送一条用户消息进去。首次调用会拉起 query。 */
  send(text: string): void {
    this.start();
    this.queue.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      // 这是人在飞书上敲的字，必须显式标记来源；
      // 缺省会被当作 unattributed，在严格的 isHuman() 信任门上 fail closed。
      origin: { kind: "human" },
    } as SDKUserMessage);
  }

  async listModels(): Promise<{ model: string; displayName?: string; description?: string }[]> {
    this.start();
    const models = await this.q!.supportedModels();
    // ModelInfo.value 才是传给 setModel 的标识；displayName 只用来展示。
    return models.map((m) => ({
      model: m.value,
      displayName: m.displayName,
      description: (m as { description?: string }).description,
    }));
  }

  async setModel(model?: string): Promise<void> {
    this.start();
    await this.q!.setModel(model);
  }

  async interrupt(): Promise<void> {
    if (!this.q) return;
    await this.q.interrupt();
  }

  /**
   * 断线重连后调用：CLI 会把仍然阻塞着的 can_use_tool 请求重新投递给 canUseTool，
   * 待审批的卡片因此不会变成孤儿。代价是回调对同一 request_id 必须幂等。
   */
  async reinitialize(): Promise<void> {
    if (!this.q) return;
    await this.q.reinitialize();
  }

  async dispose(): Promise<void> {
    this.queue.close();
    try {
      await this.q?.interrupt();
    } catch {
      // 已经停了就无所谓
    }
    await this.pump?.catch(() => {});
    this.q = null;
    this.pump = null;
  }
}

/** 过程信息只取一行摘要，过程卡不该变成刷屏日志。 */
function summarize(text: string, max = 80): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** 把工具调用渲染成一行可读的说明。 */
function describeToolUse(name: string, input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>;
  if (name === "Bash" && typeof record.command === "string") {
    return `Bash: ${summarize(record.command, 60)}`;
  }
  if (typeof record.file_path === "string") {
    return `${name}: ${record.file_path}`;
  }
  if (typeof record.pattern === "string") {
    return `${name}: ${summarize(record.pattern, 40)}`;
  }
  return name;
}

export const defaultModel = config.defaultModel;
