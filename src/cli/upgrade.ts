// fcb upgrade：一条命令升到最新，并且不用重设开机自启。
//
// 手工升级有三个坑，这条命令就是来填它们的：
//   1. 装完不重启，后台服务还跑着旧代码 —— 表面升了，行为没变；
//   2. 直接覆盖安装时服务还在跑，会撞上正被替换的文件；
//   3. fnm / nvm 换过 node 版本后，服务定义里记的 node 路径已经不存在，
//      服务安静地起不来 —— 而人只会觉得「升级把它搞坏了」。
// 所以顺序是：停服务 → 升级 → 重写服务定义并拉起。配置和会话都在
// ~/.feishu-claude-bridge，全程不碰，不需要重跑 setup。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isInstalled, install, logPath, recordedNodePath, stop } from "../service/manager.js";

const packageRoot = path.resolve(fileURLToPath(import.meta.url), "../../..");
const packageJsonPath = path.join(packageRoot, "package.json");

/** 从 git 仓库里跑（开发或克隆）还是全局装的 npm 包，升级方式不一样。 */
const fromGitCheckout = fs.existsSync(path.join(packageRoot, ".git"));

type Stamp = { version: string; commit?: string; installedAt: string };

/** git 模式下 commit 才是真信号：版本号是跟着发布走的，日常提交并不会动它。 */
function currentCommit(): string | undefined {
  if (!fromGitCheckout) return undefined;
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: packageRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    return undefined;
  }
}

function stamp(): Stamp {
  let version = "?";
  try {
    version = (JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: string })
      .version ?? "?";
  } catch {
    // 读不到版本不该挡住升级
  }
  let installedAt = "未知";
  try {
    installedAt = fs.statSync(packageJsonPath).mtime.toLocaleString("zh-CN");
  } catch {
    // 同上
  }
  const commit = currentCommit();
  return { version, ...(commit ? { commit } : {}), installedAt };
}

function describe(s: Stamp): string {
  return s.commit ? `${s.version} @${s.commit}` : `${s.version}（${s.installedAt}）`;
}

/** registry 上有没有这个包。发布之前是没有的，所以不能想当然。 */
function publishedOnNpm(name: string): boolean {
  try {
    execFileSync("npm", ["view", name, "version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * 升级源。
 *
 * 优先走 npm 包名：装一个 tarball 比从 GitHub 拉整个仓库再装依赖快一个数量级。
 * registry 上还没有（没发布，或断网）就退回 repository 推出来的 github: 简写。
 * 想升到 fork 或某个分支，直接把 spec 当参数传：
 *   fcb upgrade github:你的用户名/feishu-claude-bridge#分支名
 */
function defaultSpec(): string {
  let name: string | undefined;
  let github: string | undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      repository?: { url?: string };
      name?: string;
    };
    name = pkg.name;
    const matched = /github\.com[:/]+([^/]+)\/([^/.]+)/.exec(pkg.repository?.url ?? "");
    if (matched) github = `github:${matched[1]}/${matched[2]}`;
  } catch {
    // 落到下面的兜底
  }
  if (name && publishedOnNpm(name)) return name;
  return github ?? name ?? "github:qijieinnet/feishu-claude-bridge";
}

/** 直接把子进程的输出摊给用户看 —— npm 装 git 依赖要几分钟，没输出会以为卡死。 */
function run(command: string, args: string[], cwd?: string): void {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", ...(cwd ? { cwd } : {}) });
}

const LOCKFILE = "package-lock.json";

function upgradeFromGit(): void {
  // 锁文件单独放行：npm install 常常会顺手改写它（npm 版本不同、平台可选依赖不同
  // 都会），那是上一次升级自己留下的痕迹，不该在下一次升级时被当成「你有未提交的
  // 改动」把人拦在门外。反正它马上会被 npm install 重新生成。
  const dirty = execFileSync("git", ["status", "--porcelain"], {
    cwd: packageRoot,
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith(LOCKFILE));

  if (dirty.length > 0) {
    console.error(
      `本地有未提交的改动，先处理掉再升级（${packageRoot}）：\n${dirty.join("\n")}`,
    );
    process.exit(1);
  }

  // 给 git pull 让路，否则它会因为锁文件被改而拒绝合并
  try {
    execFileSync("git", ["checkout", "--", LOCKFILE], { cwd: packageRoot, stdio: "pipe" });
  } catch {
    // 没改过、或者根本没这个文件，都不影响后面
  }

  run("git", ["pull", "--ff-only"], packageRoot);
  run("npm", ["install"], packageRoot);
}

function upgradeFromNpm(spec: string): void {
  const slow = spec.startsWith("github:") || spec.includes("://");
  console.log(
    `从 ${spec} 升级${slow ? "（要拉整个仓库并装依赖，通常要几分钟）" : ""}…`,
  );
  run("npm", ["install", "-g", spec]);
}

/**
 * 用「刚装上的那份代码」去写服务定义，而不是我们手上这份。
 *
 * upgrade 全程跑的是升级前的代码 —— 直接调进程内的 install() 会把旧模板
 * 原样写回去，服务定义的任何改动都要等到下一次升级才生效，永远慢一拍。
 * （踩过：修好了 unit 里的 PATH 和日志落盘，升完却发现 unit 还是旧的。）
 * 所以另起一个进程执行新代码的 service install。
 */
function reinstallServiceWithNewCode(): void {
  try {
    execFileSync(process.execPath, [path.join(packageRoot, "bin", "cli.js"), "service", "install"], {
      stdio: "inherit",
    });
  } catch {
    // 新代码有问题就退回旧路径：宁可服务定义旧一点，也不能把服务撂在停着的状态
    console.warn("   新版本的 service install 没跑通，退回用当前代码重装");
    install({ quiet: true });
  }
}

function main(): void {
  const spec = process.argv[2];
  const before = stamp();
  console.log(
    `当前：${describe(before)}（${fromGitCheckout ? "git 仓库" : "全局安装"}）\n` +
      `位置：${packageRoot}`,
  );

  const serviceInstalled = isInstalled();
  const nodeChanged = serviceInstalled && recordedNodePath() !== process.execPath;
  if (serviceInstalled) {
    console.log("先停掉后台服务，避免覆盖到正在使用的文件…");
    stop();
  }

  let failed: unknown;
  try {
    if (fromGitCheckout) upgradeFromGit();
    else upgradeFromNpm(spec ?? defaultSpec());
  } catch (err) {
    failed = err;
  }

  if (serviceInstalled) {
    // 重装而不是简单 start：node 路径、入口路径可能都变了，这一步一并修好。
    // 只重写服务定义文件，配置和会话不动。
    console.log("\n重启后台服务…");
    reinstallServiceWithNewCode();
    if (nodeChanged) console.log("   （顺带修好了变化过的 node 路径）");
  }

  if (failed) {
    console.error(
      `\n❌ 升级失败，已用原来的版本把服务恢复运行。\n` +
        `   ${failed instanceof Error ? failed.message : String(failed)}\n` +
        `   权限不足报 EACCES 的话，说明当初是用 sudo 装的，升级也要加 sudo。`,
    );
    process.exit(1);
  }

  const after = stamp();
  // git 模式比 commit（版本号日常不动，比它会得出假阴性）；
  // 全局安装没有 commit 可比，只能看包文件有没有被重新铺过
  const moved =
    before.commit && after.commit
      ? before.commit !== after.commit
      : after.installedAt !== before.installedAt;

  console.log(
    moved
      ? `\n✅ 已升级：${describe(before)} → ${describe(after)}`
      : `\n✅ 已经是最新：${describe(after)}`,
  );
  if (!moved && !fromGitCheckout) {
    // 全局安装看不出变化时，八成是 npm 拿了缓存里的旧 commit
    console.log("   确认远端有新提交却没更新的话：npm cache clean --force 后重跑");
  }
  if (serviceInstalled) {
    console.log(`   后台服务已用新代码起来了，日志：${logPath}`);
  } else {
    console.log("   没装开机自启，重新执行 fcb start 即可（或 fcb service install 让它常驻）");
  }
  console.log("   配置、配对和会话都在 ~/.feishu-claude-bridge，升级不会动它们");
  console.log("   想确认一切正常：fcb doctor");
}

main();
