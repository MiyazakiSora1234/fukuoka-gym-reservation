// AWS Lambda の入口
//   worker  … EventBridge から定期実行（空き確認）／ webhook から非同期で呼ばれる（予約）
//   webhook … LINE の Webhook（Lambda 関数URL）。すぐ返信して、時間のかかる予約は worker に回す
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { runCheck, runBook, handleCommand } from './app.ts';
import { notify, reply, textMessage, verifySignature, dataToSlot, formatSlot } from './notify.ts';
import { loadJSON, saveJSON } from './store.ts';
import type { Slot } from './site.ts';

type WorkerEvent = { action?: 'check' } | { action: 'book'; slot: Slot };

export async function worker(event: WorkerEvent) {
  if (event.action === 'book') return runBook(event.slot, true);
  // 失敗が続いたときだけ知らせる（サイトの仕様変更など）
  const health = await loadJSON('health.json', { failures: 0 });
  try {
    await runCheck();
    if (health.failures) await saveJSON('health.json', { failures: 0 });
  } catch (e) {
    console.error(e);
    health.failures++;
    await saveJSON('health.json', health);
    if (health.failures === 3) await notify(`⚠️ 空き確認が3回続けて失敗しました: ${(e as Error).message.slice(0, 300)}`);
  }
}

const lambda = new LambdaClient({});

export async function webhook(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
  if (!verifySignature(raw, event.headers['x-line-signature'])) return { statusCode: 401, body: 'bad signature' };

  for (const e of JSON.parse(raw).events ?? []) {
    if (e.type === 'message' && e.message?.type === 'text') {
      await reply(e.replyToken, await handleCommand(e.message.text));
    } else if (e.type === 'postback') {
      const slot = dataToSlot(e.postback.data);
      if (!slot) continue;
      await reply(e.replyToken, [textMessage(`⏳ ${formatSlot(slot)} の予約を進めています。1分ほどで結果を送ります`)]);
      await lambda.send(
        new InvokeCommand({
          FunctionName: process.env.WORKER_FUNCTION,
          InvocationType: 'Event',
          Payload: JSON.stringify({ action: 'book', slot } satisfies WorkerEvent),
        }),
      );
    } else if (e.type === 'follow') {
      await reply(e.replyToken, [textMessage('🏸 バドミントン通知です。空きが出たらお知らせします。「ヘルプ」で使い方を表示します')]);
    }
  }
  return { statusCode: 200, body: 'ok' };
}
