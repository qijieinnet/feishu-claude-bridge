// 提示用户「去终端敲这条」时，得说他这台机器上真能跑的那条。
//
// 全局装出来的入口是 fcb / feishu-claude-bridge，在 PATH 里，哪个目录都能跑；
// 而 `npm run xxx` 只在源码目录里有效 —— 全局安装的人在家目录敲它，
// 只会得到一句 ENOENT: 找不到 /home/you/package.json，然后卡在那儿。
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 包本身是不是被装进了 node_modules（全局或本地安装），而不是源码 checkout。 */
function installed(): boolean {
  const root = path.resolve(fileURLToPath(import.meta.url), "../..");
  return root.split(path.sep).includes("node_modules");
}

/**
 * 把子命令渲染成用户可以照抄的一整条命令。
 *
 * 优先用实际被调起的那个名字（fcb / feishu-claude-bridge）；
 * 服务托管时入口固定是 bin/cli.js，这时就看包在不在 node_modules 里。
 */
export function cliCommand(args: string): string {
  const invoked = path.basename(process.argv[1] ?? "");
  const bin = invoked && invoked !== "cli.js" ? invoked : installed() ? "fcb" : null;
  if (bin) return `${bin} ${args}`;

  const [script = "", ...rest] = args.split(/\s+/);
  return rest.length > 0 ? `npm run ${script} -- ${rest.join(" ")}` : `npm run ${script}`;
}
