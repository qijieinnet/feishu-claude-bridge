// 一次性体检，把「能不能跑」拆成几条明确的结论：`fcb doctor`。
import path from "node:path";
// 只为了副作用：从 ~/.feishu-claude-bridge/.env 加载配置。
// 用 dotenv/config 会读 cwd 下的 .env —— 全局安装后基本读不到。
import { envPath } from "../home.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { diagnose } from "../claude/errors.js";
import { cliCommand } from "../cli-hint.js";

const ok = (msg: string) => console.log(`  ✅ ${msg}`);
const bad = (msg: string) => console.log(`  ❌ ${msg}`);
const warn = (msg: string) => console.log(`  ⚠️  ${msg}`);

let failures = 0;

function checkEnv(): boolean {
  console.log("\n[1/3] 配置");
  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  const allowFrom = (process.env.FEISHU_ALLOW_FROM ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.startsWith("ou_"));
  const workspace = process.env.BRIDGE_WORKSPACE_ROOT?.trim();

  if (!appId || !appSecret) {
    bad(`缺少飞书凭证（${envPath}），先跑：feishu-claude-bridge setup`);
    failures++;
    return false;
  }
  ok(`飞书应用 ${appId}`);

  if (allowFrom.length === 0) {
    warn(`owner 名单为空，只有经 \`${cliCommand("pair approve")}\` 批准的人能用`);
  } else {
    ok(`owner ${allowFrom.length} 人`);
  }

  if (!workspace) {
    warn(`未设 BRIDGE_WORKSPACE_ROOT，将退回当前目录（${process.cwd()}）`);
  } else if (path.resolve(workspace) === process.cwd()) {
    bad("工作目录就是桥接器自身，Claude 会在桥接器代码里干活；请改 BRIDGE_WORKSPACE_ROOT");
    failures++;
  } else {
    ok(`工作目录 ${workspace}`);
  }
  return true;
}

async function checkFeishu(): Promise<void> {
  console.log("\n[2/3] 飞书连通性");
  try {
    const res = await fetch(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: process.env.FEISHU_APP_ID,
          app_secret: process.env.FEISHU_APP_SECRET,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const data = (await res.json()) as { code?: number; msg?: string };
    if (data.code === 0) ok("凭证有效，能拿到 tenant_access_token");
    else {
      bad(`飞书拒绝了凭证：code=${data.code} msg=${data.msg}`);
      failures++;
    }
  } catch (err) {
    bad(`连不上飞书：${err instanceof Error ? err.message : String(err)}`);
    failures++;
  }
}

async function checkClaude(): Promise<void> {
  console.log("\n[3/3] Claude 认证（会真的跑一次极短的请求）");
  try {
    for await (const message of query({
      prompt: "回复 OK 两个字，不要别的",
      options: { permissionMode: "default", allowedTools: [] },
    })) {
      if (message.type === "result") {
        if (message.subtype === "success" && !/error|fail/i.test(message.result)) {
          ok("Claude 可用");
          return;
        }
        const diagnosis = diagnose(message.subtype === "success" ? message.result : message.subtype);
        bad(diagnosis.consoleHint);
        failures++;
        return;
      }
    }
    bad("Claude 没有返回结果");
    failures++;
  } catch (err) {
    bad(diagnose(err).consoleHint);
    failures++;
  }
}

async function main(): Promise<void> {
  console.log("feishu-claude-bridge 体检");
  if (checkEnv()) {
    await checkFeishu();
    await checkClaude();
  }
  console.log(
    failures === 0
      ? "\n一切正常，npm start 即可。\n"
      : `\n${failures} 项需要处理，按上面的提示修复后再启动。\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
