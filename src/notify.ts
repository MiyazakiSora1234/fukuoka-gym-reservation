// LINE Messaging API のプッシュメッセージで自分に通知する
// （LINE Notify は 2025年3月で終了したため Messaging API を使う）
import { env } from './config.ts';

export async function notify(text: string) {
  console.log(`[通知] ${text}`);
  if (!env.lineToken || !env.lineUserId) {
    console.warn('LINE_CHANNEL_ACCESS_TOKEN / LINE_USER_ID が未設定なので LINE には送りません');
    return;
  }
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.lineToken}` },
    body: JSON.stringify({ to: env.lineUserId, messages: [{ type: 'text', text: text.slice(0, 5000) }] }),
  });
  if (!res.ok) console.error(`LINE 送信失敗: ${res.status} ${await res.text()}`);
}
