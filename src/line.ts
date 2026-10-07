// LINE Messaging API
// （LINE Notify は 2025年3月で終了したため Messaging API を使う）
// LINE_USER_ID があればその人にプッシュ、なければ公式アカウントの友だち全員にブロードキャストする。
// 自分専用の公式アカウントなら、どちらでも届くのは自分だけ
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config, env, weekdayOf } from './config.ts';
import type { Slot } from './site.ts';

export type Message = Record<string, unknown>;

async function call(path: string, body: unknown) {
  const res = await fetch(`https://api.line.me/v2/bot/message/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.lineToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error(`LINE 送信失敗: ${res.status} ${await res.text()}`);
}

export async function send(messages: Message[]) {
  if (!env.lineToken) {
    console.warn('LINE_CHANNEL_ACCESS_TOKEN が未設定なので LINE には送りません');
    return;
  }
  if (env.lineUserId) await call('push', { to: env.lineUserId, messages });
  else await call('broadcast', { messages });
}

/** Webhook の返信。プッシュと違って無料プランの通数に数えられない */
export async function reply(replyToken: string, messages: Message[]) {
  await call('reply', { replyToken, messages });
}

export async function notify(text: string) {
  console.log(`[通知] ${text}`);
  await send([textMessage(text)]);
}

export const COMMANDS = ['状況', '止めて', '再開', '自動予約オン', '自動予約オフ', 'ヘルプ'];

export function textMessage(text: string): Message {
  return {
    type: 'text',
    text: text.slice(0, 5000),
    quickReply: { items: COMMANDS.map((c) => ({ type: 'action', action: { type: 'message', label: c, text: c } })) },
  };
}

export function formatSlot(s: Slot) {
  return `${s.date.slice(5).replace('-', '/')}(${weekdayOf(s.date)}) ${s.from}-${s.to} ${s.facility.replace('（個人利用）', '')}`;
}

/** 「予約する」ボタンの postback。300文字制限があるので施設は config.facilities の番号で持つ */
export function slotToData(s: Slot) {
  return `book|${config.facilities.indexOf(s.facility)}|${s.date}|${s.from}|${s.to}`;
}

export function dataToSlot(data: string): Slot | undefined {
  const [kind, idx, date, from, to] = data.split('|');
  const facility = config.facilities[Number(idx)];
  if (kind !== 'book' || !facility) return undefined;
  return { facility, room: config.sport, date, from, to };
}

/** 空き枠の一覧。1枠ごとに「予約する」ボタンを付ける */
export function vacancyMessage(title: string, slots: Slot[]): Message {
  const shown = slots.slice(0, 10);
  return {
    type: 'flex',
    altText: `${title}\n${slots.map(formatSlot).join('\n')}`.slice(0, 400),
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: title, weight: 'bold', wrap: true },
          ...shown.map((s) => ({
            type: 'box',
            layout: 'horizontal',
            alignItems: 'center',
            contents: [
              { type: 'text', text: formatSlot(s), size: 'sm', wrap: true, flex: 3 },
              {
                type: 'button',
                style: 'primary',
                height: 'sm',
                flex: 2,
                action: { type: 'postback', label: '予約する', data: slotToData(s), displayText: `${formatSlot(s)} を予約` },
              },
            ],
          })),
          ...(slots.length > shown.length
            ? [{ type: 'text', text: `ほか ${slots.length - shown.length} 件`, size: 'xs', color: '#888888' }]
            : []),
        ],
      },
    },
    quickReply: textMessage('').quickReply,
  };
}

export function verifySignature(rawBody: string, signature: string | undefined) {
  if (!env.lineSecret || !signature) return false;
  const expected = createHmac('sha256', env.lineSecret).update(rawBody).digest();
  const given = Buffer.from(signature, 'base64');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
