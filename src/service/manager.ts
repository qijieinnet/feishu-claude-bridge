// 开机自启的注册与生命周期。
//
// macOS 用 LaunchAgent，Linux 用 systemd user service，都是「用户级」——
// 不需要 sudo，也不碰系统全局配置。
//
// 这里只有逻辑，命令行外壳在 cli/service.ts。拆开是因为 upgrade 也要用它：
// 升级要能停服务、重装服务定义、再拉起来，而不是让用户自己去背 launchctl。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bridgeHome, envPath } from "../home.js";

const LABEL = "com.feishu-claude-bridge";
const UNIT = "feishu-claude-bridge";
const logDir = path.join(bridgeHome, "logs");

/** bin/cli.js 的绝对路径 */
export function entryPath(): string {
  return path.resolve(fileURLToPath(import.meta.url), "../../../bin/cli.js");
}

export const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
export const systemdPath = path.join(
  os.homedir(),
  ".config",
  "systemd",
  "user",
  `${UNIT}.service`,
);

export const logPath = path.join(logDir, "out.log");

function uid(): number {
  return process.getuid?.() ?? 501;
}

/**
 * 写进服务定义的 PATH。
 *
 * 不能只抄当前 shell 的 PATH：装服务时用的是哪个 shell 全凭运气 —— 从 SSH
 * 非交互会话跑一次 install，PATH 里就没有 ~/.npm-global/bin，而 `claude`
 * 恰恰装在那儿。服务照样起得来，直到第一次真要调 Claude 才报「找不到」。
 * 所以把 node 自己所在的目录和 npm 全局 bin 显式并进去。
 */
export function servicePath(): string {
  const parts = [
    path.dirname(process.execPath),
    npmGlobalBin(),
    process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  ];
  const seen = new Set<string>();
  return parts
    .filter((entry): entry is string => !!entry)
    .flatMap((entry) => entry.split(":"))
    .filter((dir) => dir && !seen.has(dir) && (seen.add(dir), true))
    .join(":");
}

/**
 * npm 全局 bin 目录。从入口文件的位置反推，不用 spawn npm：
 * <prefix>/lib/node_modules/feishu-claude-bridge/bin/cli.js → <prefix>/bin
 * 从 git 仓库里跑时推出来的是个不存在的目录，会被下面的 existsSync 滤掉。
 */
function npmGlobalBin(): string | undefined {
  const guess = path.resolve(entryPath(), "../../../../../bin");
  return fs.existsSync(guess) ? guess : undefined;
}

/** 装完就地验一下服务能不能找到 claude —— 让它在装的时候喊，而不是用的时候哑火。 */
function warnIfClaudeMissing(pathEnv: string): void {
  const found = pathEnv
    .split(":")
    .some((dir) => dir && fs.existsSync(path.join(dir, "claude")));
  if (!found) {
    console.warn("⚠️  服务的 PATH 里找不到 claude，起来之后会报「找不到 Claude Code」。");
    console.warn("   确认一下 Claude Code 装在哪：command -v claude");
  }
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] ?? c,
  );
}

export function buildPlist(): string {
  // launchd 的默认 PATH 极窄，找不到 node 也找不到 claude
  const pathEnv = servicePath();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(entryPath())}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>${escapeXml(bridgeHome)}</string>
  <key>StandardOutPath</key><string>${escapeXml(path.join(logDir, "out.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(logDir, "err.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escapeXml(pathEnv)}</string>
    <key>BRIDGE_HOME</key><string>${escapeXml(bridgeHome)}</string>
  </dict>
</dict>
</plist>
`;
}

export function buildSystemdUnit(): string {
  const pathEnv = servicePath();
  return `[Unit]
Description=feishu-claude-bridge
After=network-online.target
# systemd 默认「10 秒内重启 5 次就永久放弃」，那正是崩溃循环最需要它别放弃的时候。
# launchd 那边是无条件重启的，这里对齐。
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=${process.execPath} ${entryPath()} start
WorkingDirectory=${bridgeHome}
# 不写这两行的话日志只进 journald，而普通用户往往读不到自己的 user unit 日志
# （配对码、审批提示就此消失）。append: 需要 systemd >= 240，2020 年后的发行版都有。
StandardOutput=append:${path.join(logDir, "out.log")}
StandardError=append:${path.join(logDir, "err.log")}
Environment=PATH=${pathEnv}
Environment=BRIDGE_HOME=${bridgeHome}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/**
 * 「本来就没在跑」不是错误。
 *
 * install 会先 bootout 再 bootstrap，而 upgrade 更是已经先停过一次了 ——
 * 此时 launchctl 必然抱怨找不到这个 job。照实打出来只会让人以为升级出了岔子。
 */
const NOT_RUNNING = /No such process|Could not find specified service|not loaded/i;

function run(command: string, args: string[]): void {
  try {
    execFileSync(command, args, { stdio: "pipe" });
  } catch (err) {
    const detail = (err as { stderr?: Buffer }).stderr?.toString().trim();
    if (detail && !NOT_RUNNING.test(detail)) {
      console.warn(`  ${command} ${args.join(" ")}: ${detail}`);
    }
  }
}

/** 服务定义文件在不在。 */
export function isInstalled(): boolean {
  if (process.platform === "darwin") return fs.existsSync(plistPath);
  if (process.platform === "linux") return fs.existsSync(systemdPath);
  return false;
}

/**
 * 服务定义里记的 node 路径。
 *
 * fnm / nvm 换个 node 版本，这个路径就没了 —— 服务于是安静地起不来。
 * 升级时顺手比对一下，不一致就重写定义。
 */
export function recordedNodePath(): string | undefined {
  try {
    if (process.platform === "darwin") {
      const xml = fs.readFileSync(plistPath, "utf8");
      return /<array>\s*<string>([^<]+)<\/string>/.exec(xml)?.[1];
    }
    if (process.platform === "linux") {
      const unit = fs.readFileSync(systemdPath, "utf8");
      return /^ExecStart=(\S+)/m.exec(unit)?.[1];
    }
  } catch {
    // 读不到就当没记过
  }
  return undefined;
}

export function stop(): void {
  if (process.platform === "darwin") {
    run("launchctl", ["bootout", `gui/${uid()}/${LABEL}`]);
  } else if (process.platform === "linux") {
    run("systemctl", ["--user", "stop", UNIT]);
  }
}

/**
 * 写入服务定义并拉起来。
 *
 * 重复执行是安全的，而且刻意做成幂等的「重装」：升级后照样调一次，
 * node 路径变了、入口路径变了都在这一步一并修好。
 * 只碰服务定义文件，不碰 ~/.feishu-claude-bridge 里的配置与会话。
 */
export function install(options: { quiet?: boolean } = {}): void {
  const say = (line: string) => {
    if (!options.quiet) console.log(line);
  };
  fs.mkdirSync(logDir, { recursive: true });

  // 没配置也照样装 —— 但要说清楚，否则服务会起来即崩，日志还在别处。
  if (!fs.existsSync(envPath)) {
    console.warn(`⚠️  还没有配置（${envPath} 不存在）`);
    console.warn("   服务会一直重启失败，先跑：feishu-claude-bridge setup\n");
  }

  if (process.platform === "darwin") {
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, buildPlist());
    // 先卸掉旧的，避免重复安装时报 already loaded
    run("launchctl", ["bootout", `gui/${uid()}/${LABEL}`]);
    run("launchctl", ["bootstrap", `gui/${uid()}`, plistPath]);
    say(`✅ 已注册为开机自启：${plistPath}`);
  } else if (process.platform === "linux") {
    fs.mkdirSync(path.dirname(systemdPath), { recursive: true });
    fs.writeFileSync(systemdPath, buildSystemdUnit());
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", UNIT]);
    // 必须是 restart 而不是 enable --now：--now 只管「没在跑就拉起来」，
    // 对已经在跑的服务什么都不做 —— 升级完照样跑着旧代码，白升一场。
    run("systemctl", ["--user", "restart", UNIT]);
    say(`✅ 已注册为开机自启：${systemdPath}`);
    say("   未登录时也要运行的话，执行：sudo loginctl enable-linger $USER");
  } else {
    console.error(`暂不支持的平台：${process.platform}`);
    process.exit(1);
  }

  warnIfClaudeMissing(servicePath());
  say(`   日志：${logPath}`);
  say("   查看状态：feishu-claude-bridge service status");
}

export function uninstall(): void {
  if (process.platform === "darwin") {
    run("launchctl", ["bootout", `gui/${uid()}/${LABEL}`]);
    fs.rmSync(plistPath, { force: true });
    console.log("✅ 已取消开机自启");
  } else if (process.platform === "linux") {
    run("systemctl", ["--user", "disable", "--now", UNIT]);
    fs.rmSync(systemdPath, { force: true });
    run("systemctl", ["--user", "daemon-reload"]);
    console.log("✅ 已取消开机自启");
  }
}

/** 重启：走「重装」而不是 start，顺手把变了的 node / 入口路径修好。 */
export function restart(): void {
  if (!isInstalled()) {
    console.log("还没注册开机自启，先跑：feishu-claude-bridge service install");
    return;
  }
  install({ quiet: true });
  console.log("✅ 服务已重启");
}

export function status(): void {
  if (process.platform === "darwin") {
    const installed = fs.existsSync(plistPath);
    console.log(`配置文件：${installed ? plistPath : "未安装"}`);
    if (!installed) return;
    try {
      const out = execFileSync("launchctl", ["list"], { encoding: "utf8" });
      const line = out.split("\n").find((l) => l.includes(LABEL));
      console.log(line ? `运行中：${line.trim()}` : "已安装但当前未运行");
    } catch {
      console.log("无法读取 launchctl 状态");
    }
  } else if (process.platform === "linux") {
    console.log(`配置文件：${fs.existsSync(systemdPath) ? systemdPath : "未安装"}`);
    try {
      console.log(
        execFileSync("systemctl", ["--user", "is-active", UNIT], {
          encoding: "utf8",
        }).trim(),
      );
    } catch {
      console.log("未运行");
    }
  }
  console.log(`日志：${logPath}`);
}
