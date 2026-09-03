#!/usr/bin/env node
// 统一入口：feishu-claude-bridge <setup|start|pair|doctor>
//
// 源码是 TypeScript，这里用 tsx 的 ESM loader 直接加载，
// 省掉构建步骤 —— 装完即可运行，不需要用户先 build。
import { register } from "tsx/esm/api";

const COMMANDS = {
  setup: "../src/setup/cli.ts",
  start: "../src/index.ts",
  pair: "../src/cli/pair.ts",
  doctor: "../src/cli/doctor.ts",
  service: "../src/cli/service.ts",
  upgrade: "../src/cli/upgrade.ts",
};

const USAGE = `feishu-claude-bridge —— 在飞书里聊天驱动本机 Claude Code

用法：
  feishu-claude-bridge setup     扫码创建飞书应用，写入配置
  feishu-claude-bridge doctor    体检：配置 / 飞书连通性 / Claude 认证
  feishu-claude-bridge start     启动桥接器（默认命令）
  feishu-claude-bridge pair ...  配对管理：list | approve <CODE> | revoke <open_id>
  feishu-claude-bridge service ... 开机自启：install | uninstall | restart | status
  feishu-claude-bridge upgrade   升级到最新版并重启服务（不动配置和自启）

配置目录：~/.feishu-claude-bridge（可用 BRIDGE_HOME 覆盖）
文档：https://github.com/qijieinnet/feishu-claude-bridge
`;

const [, , rawCommand, ...rest] = process.argv;
const command = rawCommand ?? "start";

if (command === "-h" || command === "--help" || command === "help") {
  process.stdout.write(USAGE);
  process.exit(0);
}

const target = COMMANDS[command];
if (!target) {
  process.stderr.write(`未知命令：${command}\n\n${USAGE}`);
  process.exit(1);
}

// 让子命令看到的 argv 与直接运行脚本时一致（去掉子命令这一层）
process.argv = [process.argv[0], process.argv[1], ...rest];

register();
try {
  await import(new URL(target, import.meta.url).href);
} catch (err) {
  // 配置缺失之类的问题，用户要看的是一句话怎么修，不是一屏 ESM 调用栈。
  // 真要排查时 BRIDGE_DEBUG=1 把原始栈打出来。
  if (process.env.BRIDGE_DEBUG) throw err;
  process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
}
