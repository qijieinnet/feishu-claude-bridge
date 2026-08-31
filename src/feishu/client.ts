// 飞书客户端封装：发文本、发卡片、原地更新卡片。
import * as Lark from "@larksuiteoapi/node-sdk";
import { config } from "../config.js";

export const larkClient = new Lark.Client({
  appId: config.feishu.appId,
  appSecret: config.feishu.appSecret,
});

export async function sendText(chatId: string, text: string): Promise<string | undefined> {
  const res = await larkClient.im.v1.message.create({
    params: { receive_id_type: "chat_id" },
    data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
  });
  return res.data?.message_id;
}

export async function sendCard(
  chatId: string,
  card: unknown,
): Promise<string | undefined> {
  const res = await larkClient.im.v1.message.create({
    params: { receive_id_type: "chat_id" },
    data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) },
  });
  const messageId = res.data?.message_id;
  // 拿不到 message_id 就意味着这张卡片之后永远无法被更新，必须喊出来
  if (!messageId) {
    console.warn("[feishu] 发卡成功但没拿到 message_id，该卡片将无法更新:", JSON.stringify(res).slice(0, 300));
  }
  return messageId;
}

/**
 * 原地更新卡片。
 *
 * 飞书对单条消息的编辑次数有上限（实测约 20 次），超了会失败。
 * 这里不抛异常，返回 false 让调用方决定是否改为「发一条新卡片接续」。
 */
// message_id → card_id 的映射，以及每张卡片的更新序号。
// cardkit 的全量更新要求 sequence 严格递增，同一张卡片必须自己记着。
const cardIdByMessage = new Map<string, string>();
const sequenceByCard = new Map<string, number>();

function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V, max = 500): void {
  map.set(key, value);
  if (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/** 把发送消息拿到的 message_id 换成卡片实体 id。 */
async function resolveCardId(messageId: string): Promise<string | undefined> {
  const cached = cardIdByMessage.get(messageId);
  if (cached) return cached;
  try {
    const res = await larkClient.cardkit.v1.card.idConvert({ data: { message_id: messageId } });
    const cardId = res.data?.card_id;
    if (cardId) rememberBounded(cardIdByMessage, messageId, cardId);
    return cardId;
  } catch (err) {
    const data = (err as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
    console.warn(
      `[feishu] message_id ${messageId} 转 card_id 失败: ` +
        (data ? `code=${data.code} msg=${data.msg}` : String(err)),
    );
    return undefined;
  }
}

/**
 * 更新一张已发出的卡片。
 *
 * 走 cardkit 的全量更新：它是 JSON 2.0 卡片的正规更新通道。
 * 老的 im.v1.message.patch 属于 1.0 时代，对 2.0 卡片并不可靠 —— 带交互组件的
 * 卡片就更新不动，审批卡因此一直停在待授权状态。patch 仅作为回退。
 */
export async function updateCard(messageId: string, card: unknown): Promise<boolean> {
  const cardId = await resolveCardId(messageId);
  if (cardId) {
    const sequence = (sequenceByCard.get(cardId) ?? Math.floor(Date.now() / 1000)) + 1;
    rememberBounded(sequenceByCard, cardId, sequence);
    try {
      const res = await larkClient.cardkit.v1.card.update({
        path: { card_id: cardId },
        data: { card: { type: "card_json", data: JSON.stringify(card) }, sequence },
      });
      if (res.code === 0) return true;
      console.warn(`[feishu] cardkit 更新 ${cardId} 被拒绝: code=${res.code} msg=${res.msg}`);
    } catch (err) {
      const data = (err as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
      console.warn(
        `[feishu] cardkit 更新 ${cardId} 失败: ` +
          (data ? `code=${data.code} msg=${data.msg}` : String(err)),
      );
    }
  }

  // 回退到旧接口，尽最大努力
  try {
    const res = await larkClient.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
    if (res.code !== 0) {
      console.warn(`[feishu] patch 回退也被拒绝 ${messageId}: code=${res.code} msg=${res.msg}`);
      return false;
    }
    return true;
  } catch (err) {
    const data = (err as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
    console.warn(
      `[feishu] 更新卡片 ${messageId} 失败: ` +
        (data ? `code=${data.code} msg=${data.msg}` : err instanceof Error ? err.message : String(err)),
    );
    return false;
  }
}

/**
 * 给用户那条消息加一个「正在输入」表情，表示已收到、正在干活。
 * 飞书没有对机器人开放真正的 typing 指示器，表情回复是最接近的替代。
 * 失败不影响主流程，静默返回。
 */
export async function addTypingReaction(messageId: string): Promise<string | undefined> {
  try {
    const res = await larkClient.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: "Typing" } },
    });
    return res.data?.reaction_id;
  } catch (err) {
    console.warn("[feishu] 加表情失败:", err instanceof Error ? err.message : err);
    return undefined;
  }
}

/** 干完活把「正在输入」撤掉。 */
export async function removeReaction(messageId: string, reactionId: string): Promise<void> {
  try {
    await larkClient.im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
  } catch (err) {
    console.warn("[feishu] 删表情失败:", err instanceof Error ? err.message : err);
  }
}
