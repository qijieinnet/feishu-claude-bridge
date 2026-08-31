// 开机自启：把桥接器注册成用户级后台服务。
//
// macOS 用 LaunchAgent，Linux 用 systemd user service，都是「用户级」——
// 不需要 sudo，也不碰系统全局配置。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bridgeHome, envPath } from "../home.js";

const LABEL = "com.feishu-claude-bridge";
const logDir = path.join(bridgeHome, "logs");

/** bin/cli.js 的绝对路径 */
function entryPath(): string {
  return path.resolve(fileURLToPath(import.meta.url), "../../../bin/cli.js");
}

const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const systemdPath = path.join(
  os.homedir(),
  ".config",
  "systemd",
  "user",
  "feishu-claude-bridge.service",
);

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] ?? c,
  );
}

function buildPlist(): string {
  // launchd 的默认 PATH 极窄，找不到 node 也找不到 claude。
  // 把当前 shell 的 PATH 原样带过去，否则服务起来了却报「找不到 Claude Code」。
  const pathEnv = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
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

function buildSystemdUnit(): string {
  const pathEnv = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  return `[Unit]
Description=feishu-claude-bridge
After=network-online.target

[Service]
Type=simple
ExecStart=${process.execPath} ${entryPath()} start
WorkingDirectory=${bridgeHome}
Environment=PATH=${pathEnv}
Environment=BRIDGE_HOME=${bridgeHome}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function run(command: string, args: string[]): void {
  try {
    execFileSync(command, args, { stdio: "pipe" });
  } catch (err) {
    const detail = (err as { stderr?: Buffer }).stderr?.toString().trim();
    if (detail) console.warn(`  ${command} ${args.join(" ")}: ${detail}`);
  }
}

function install(): void {
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
    run("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${LABEL}`]);
    run("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 501}`, plistPath]);
    console.log(`✅ 已注册为开机自启：${plistPath}`);
  } else if (process.platform === "linux") {
    fs.mkdirSync(path.dirname(systemdPath), { recursive: true });
    fs.writeFileSync(systemdPath, buildSystemdUnit());
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", "feishu-claude-bridge"]);
    console.log(`✅ 已注册为开机自启：${systemdPath}`);
    console.log("   未登录时也要运行的话，执行：sudo loginctl enable-linger $USER");
  } else {
    console.error(`暂不支持的平台：${process.platform}`);
    process.exit(1);
  }

  console.log(`   日志：${path.join(logDir, "out.log")}`);
  console.log("   查看状态：feishu-claude-bridge service status");
}

function uninstall(): void {
  if (process.platform === "darwin") {
    run("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${LABEL}`]);
    fs.rmSync(plistPath, { force: true });
    console.log("✅ 已取消开机自启");
  } else if (process.platform === "linux") {
    run("systemctl", ["--user", "disable", "--now", "feishu-claude-bridge"]);
    fs.rmSync(systemdPath, { force: true });
    run("systemctl", ["--user", "daemon-reload"]);
    console.log("✅ 已取消开机自启");
  }
}

function status(): void {
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
        execFileSync("systemctl", ["--user", "is-active", "feishu-claude-bridge"], {
          encoding: "utf8",
        }).trim(),
      );
    } catch {
      console.log("未运行");
    }
  }
  console.log(`日志：${path.join(logDir, "out.log")}`);
}

const action = process.argv[2];
switch (action) {
  case "install":
    install();
    break;
  case "uninstall":
    uninstall();
    break;
  case "status":
    status();
    break;
  default:
    console.log("用法：feishu-claude-bridge service <install | uninstall | status>");
}
