// 连接看门狗。
//
// 长连接自己会重连，但它放弃的时候（不可恢复的错误，或重连次数耗尽）只是
// 发一个 onError 就停手 —— 而 SDK 的 ping 定时器是无条件续期的，进程于是
// 活得好好的：launchd / systemd 看不出任何异常，飞书那边却再也收不到消息。
// 这就是「服务卡死」，光靠进程守护发现不了，因为进程根本没死。
//
// 所以自己盯着连接状态：连续掉线超过阈值就退出重来。短暂重连不会误伤 ——
// 阈值（默认 10 分钟）远大于一次正常重连的耗时。
import { config } from "../config.js";

/** 只用到状态查询，方便测试时塞个假的进来。 */
export type ConnectionProbe = {
  getConnectionStatus: () => { state: string } | undefined;
};

export type WatchdogHooks = {
  /** 连续掉线超时后调用。默认实现是打日志并退出，交给守护进程重启。 */
  onStuck: (reason: string) => void;
  log?: (line: string) => void;
  /** 查得多勤，默认 30 秒 */
  intervalMs?: number;
};

/**
 * 主动退出，交给守护进程用一个干净的进程把它拉起来。
 *
 * 退出码给 1 而不是 0：崩溃循环在 launchctl / systemctl 里才看得出是「失败」，
 * 而不是一次次正常收工。日志里必须留下原因，否则重启看起来就像随机抽风。
 */
export function exitForRestart(reason: string): void {
  console.error(`[连接] ${reason}`);
  console.error("[连接] 主动退出，交给守护进程重启；没装自启的话请重新执行 fcb start");
  process.exit(1);
}

export function startWatchdog(
  client: ConnectionProbe,
  hooks: WatchdogHooks = { onStuck: exitForRestart },
): NodeJS.Timeout | undefined {
  if (config.watchdogMs <= 0) return undefined;
  const log = hooks.log ?? ((line: string) => console.log(line));

  let downSince: number | undefined;
  const timer = setInterval(() => {
    const state = client.getConnectionStatus()?.state;
    if (state === "connected") {
      if (downSince) log("[连接] 已恢复");
      downSince = undefined;
      return;
    }
    downSince ??= Date.now();
    const downFor = Date.now() - downSince;
    if (downFor >= config.watchdogMs) {
      hooks.onStuck(
        `长连接已断开 ${Math.round(downFor / 60000)} 分钟（状态 ${state ?? "未知"}），不再等了`,
      );
    }
  }, hooks.intervalMs ?? 30_000);

  // 不要因为看门狗自己而让进程赖着不退：连接真死透时，早点退出反而恢复得更快
  timer.unref?.();
  return timer;
}
