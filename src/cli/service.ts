// fcb service <install | uninstall | restart | status> 的命令行外壳。
// 逻辑在 service/manager.ts —— upgrade 也要用同一套。
import { install, restart, status, uninstall } from "../service/manager.js";

const action = process.argv[2];
switch (action) {
  case "install":
    install();
    break;
  case "uninstall":
    uninstall();
    break;
  case "restart":
    restart();
    break;
  case "status":
    status();
    break;
  default:
    console.log(
      "用法：feishu-claude-bridge service <install | uninstall | restart | status>",
    );
}
