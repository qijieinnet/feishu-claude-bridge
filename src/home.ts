// 配置目录的定位与 .env 的加载。
//
// 单独成一个模块，是为了和 config.ts 的必填项校验分开：setup / service
// 这类「还没配置好就要跑」的命令只需要知道目录在哪，不该被「缺少
// FEISHU_APP_ID」挡在门外 —— 否则用来生成配置的命令永远跑不起来。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

/**
 * 配置与状态的家目录。
 *
 * 全局安装后可以在任何目录敲命令，配置不能跟着 cwd 跑，否则换个目录就"失忆"。
 * 仓库里直接跑（开发模式）时，当前目录有 .env 就优先用它。
 */
export const bridgeHome = (() => {
  const explicit = process.env.BRIDGE_HOME?.trim();
  if (explicit) return path.resolve(explicit);
  const local = path.join(process.cwd(), ".env");
  if (fs.existsSync(local)) return process.cwd();
  return path.join(os.homedir(), ".feishu-claude-bridge");
})();

/** .env 的绝对路径。setup 写它，其它命令读它。 */
export const envPath = path.join(bridgeHome, ".env");

/** 会话映射、配对记录等运行时状态。 */
export const dataDir = path.join(bridgeHome, "data");

dotenv.config({ path: envPath, quiet: true });
