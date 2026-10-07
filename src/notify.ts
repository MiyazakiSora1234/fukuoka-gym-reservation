// LINE Messaging API で自分に通知する
// （LINE Notify は 2025年3月で終了したため Messaging API を使う）
// LINE_USER_ID があればその人にプッシュ、なければ公式アカウントの友だち全員にブロードキャストする。
// 自分専用の公式アカウントなら、どちらでも届くのは自分だけ
import { env } from './config.ts';

export async function notify(text: string) {
  console.log(`[通知] ${text}`);
  if (!env.lineToken) {
    console.warn('LINE_CHANNEL_ACCESS_TOKEN が未設定なので LINE には送りません');
    return;
  }
  const messages = [{ type: 'text', text: text.slice(0, 5000) }];
  const [url, body] = env.lineUserId
    ? ['https://api.line.me/v2/bot/message/push', { to: env.lineUserId, messages }]
    : ['https://api.line.me/v2/bot/message/broadcast', { messages }];
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.lineToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error(`LINE 送信失敗: ${res.status} ${await res.text()}`);
}
