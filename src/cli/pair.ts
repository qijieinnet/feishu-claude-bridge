// 配对管理：`fcb pair <list|approve CODE|revoke OPEN_ID>`（源码目录里是 `npm run pair -- ...`）
import { approve, listApproved, listPending, revoke } from "../pairing.js";
import { cliCommand } from "../cli-hint.js";

const [action, arg] = process.argv.slice(2);

switch (action) {
  case "list": {
    const pending = listPending();
    if (pending.length === 0) {
      console.log("没有待批准的配对请求。");
    } else {
      console.log("待批准：");
      for (const p of pending) {
        const age = Math.round((Date.now() - p.createdAt) / 1000);
        console.log(`  ${p.code}  ${p.name ?? p.openId}  (${age}s 前)`);
      }
    }
    const approved = listApproved();
    console.log(`\n已授权 ${approved.length} 人：${approved.join(", ") || "(无)"}`);
    break;
  }

  case "approve": {
    if (!arg) {
      console.error(`用法：${cliCommand("pair approve <CODE>")}`);
      process.exit(1);
    }
    const result = approve(arg);
    if (!result.ok) {
      console.error(`没找到配对码 ${arg.toUpperCase()}，可能已过期或已批准。`);
      process.exit(1);
    }
    console.log(`✅ 已授权 ${result.request.name ?? result.request.openId}`);
    console.log("对方可以直接继续发消息了。");
    break;
  }

  case "revoke": {
    if (!arg) {
      console.error(`用法：${cliCommand("pair revoke <open_id>")}`);
      process.exit(1);
    }
    console.log(revoke(arg) ? `已撤销 ${arg}` : `${arg} 不在授权名单里`);
    break;
  }

  default:
    console.log(`用法：${cliCommand("pair <list | approve CODE | revoke OPEN_ID>")}`);
}
