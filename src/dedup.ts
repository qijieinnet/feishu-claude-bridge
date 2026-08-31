// 事件去重。飞书对消息和卡片回调都可能重投，不挡住就会重复执行：
// 消息重投 = 同一句话跑两遍；回调重投 = 第一次消费掉 pending，第二次误报「已失效」。
const seen = new Set<string>();
const MAX_KEYS = 2000;

export function isDuplicate(id: string | undefined): boolean {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > MAX_KEYS) {
    // 简单的容量控制：丢掉最早的一半
    for (const key of Array.from(seen).slice(0, MAX_KEYS / 2)) seen.delete(key);
  }
  return false;
}

export function resetDedup(): void {
  seen.clear();
}
