// `npm run setup`：扫码创建飞书应用，自动写入 .env。
import fs from "node:fs";
import path from "node:path";
import {
  beginRegistration,
  initRegistration,
  pollRegistration,
  printQrCode,
} from "./register.js";

const ENV_PATH = path.join(process.cwd(), ".env");

/** 就地更新 .env 的某个键，保留其它内容和注释。 */
function upsertEnv(
  updates: Record<string, string>,
  opts: { onlyIfMissing?: string[] } = {},
): void {
  let content = "";
  try {
    content = fs.readFileSync(ENV_PATH, "utf8");
  } catch {
    content = "";
  }

  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    const exists = pattern.test(content);
    // 用户自己配过的值不覆盖
    if (exists && opts.onlyIfMissing?.includes(key)) continue;
    content = exists
      ? content.replace(pattern, line)
      : `${content.trimEnd()}\n${line}\n`;
  }

  fs.writeFileSync(ENV_PATH, content.trimStart(), { mode: 0o600 });
}

async function main(): Promise<void> {
  console.log("正在与飞书握手…\n");
  await initRegistration();

  const begin = await beginRegistration();

  console.log("请用飞书 App 扫描下面的二维码，然后在手机上选择「新建」或「已有」机器人：\n");
  await printQrCode(begin.qrUrl);
  console.log(`\n扫不了码就打开这个链接：\n${begin.qrUrl}\n`);
  console.log(`验证码：${begin.userCode}`);
  console.log(`有效期约 ${Math.round(begin.expireIn / 60)} 分钟，等待确认中…\n`);

  let lastPrinted = 0;
  const outcome = await pollRegistration({
    deviceCode: begin.deviceCode,
    interval: begin.interval,
    expireIn: begin.expireIn,
    onTick: (secondsLeft) => {
      // 每 30 秒提示一次，别刷屏
      if (lastPrinted - secondsLeft >= 30 || lastPrinted === 0) {
        lastPrinted = secondsLeft;
        process.stdout.write(`  仍在等待…（剩余约 ${secondsLeft}s）\n`);
      }
    },
  });

  switch (outcome.status) {
    case "access_denied":
      console.error("\n你在手机上拒绝了授权。");
      process.exit(1);
    // eslint-disable-next-line no-fallthrough
    case "expired":
    case "timeout":
      console.error("\n二维码已过期，请重新运行 npm run setup。");
      process.exit(1);
    // eslint-disable-next-line no-fallthrough
    case "error":
      console.error(`\n注册失败：${outcome.message}`);
      process.exit(1);
  }

  if (outcome.status !== "success") return;
  const { appId, appSecret, domain, openId } = outcome.result;

  // 默认工作目录取桥接器的父目录，而不是桥接器自己 —— 否则 Claude 会在
  // 桥接器的代码里干活，几乎肯定不是你想要的。
  const defaultWorkspace = path.dirname(process.cwd());

  upsertEnv(
    {
      FEISHU_APP_ID: appId,
      FEISHU_APP_SECRET: appSecret,
      FEISHU_DOMAIN: domain,
      BRIDGE_WORKSPACE_ROOT: defaultWorkspace,
      ...(openId ? { FEISHU_ALLOW_FROM: openId } : {}),
    },
    { onlyIfMissing: ["BRIDGE_WORKSPACE_ROOT", "FEISHU_ALLOW_FROM"] },
  );

  console.log("\n✅ 应用已创建，凭证已写入 .env");
  console.log(`   App ID：${appId}`);
  console.log(`   域：${domain}`);
  console.log(`   工作目录：${defaultWorkspace}`);
  if (openId) {
    console.log(`   已把你（${openId}）加入授权名单`);
  } else {
    console.log("   ⚠️ 没拿到你的 open_id，首次给机器人发消息时会走配对流程");
  }

  console.log("\n还差一步：到开发者后台确认「事件与回调」用的是长连接，并订阅");
  console.log("im.message.receive_v1。若已自动配好，直接 npm start 即可。\n");
}

main().catch((err) => {
  console.error("setup 失败：", err instanceof Error ? err.message : err);
  process.exit(1);
});
