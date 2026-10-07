// AWS Lambda の入口
//   worker  … EventBridge から定期実行（空き確認）／ webhook から非同期で呼ばれる（今すぐ確認・予約・ログイン確認）
//   webhook … 関数URL。POST / は LINE の Webhook、/credentials はログイン情報の入力ページ
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { runCheck, runBook, runVerifyLogin, handleText, handlePostback, welcome, type Handled } from './app.ts';
import { notify, reply, verifySignature, parsePostback } from './line.ts';
import { loadJSON, saveJSON } from './store.ts';
import { handleCredentialsPage, CREDENTIALS_PATH } from './web.ts';

type WorkerEvent = { action?: 'check'; report?: boolean } | NonNullable<Handled['invoke']>;

export async function worker(event: WorkerEvent) {
  if (event.action === 'book') return runBook(event.slot, true);
  if (event.action === 'verify-login') return runVerifyLogin();
  const report = 'report' in event && !!event.report;
  // 定期実行の失敗は続いたときだけ知らせる（サイトの仕様変更など）
  const health = await loadJSON('health.json', { failures: 0 });
  try {
    await runCheck({ report });
    if (health.failures) await saveJSON('health.json', { failures: 0 });
  } catch (e) {
    console.error(e);
    health.failures++;
    await saveJSON('health.json', health);
    const msg = (e as Error).message.slice(0, 300);
    if (report) await notify(`⚠️ 空きを確認できませんでした: ${msg}`);
    else if (health.failures === 3) await notify(`⚠️ 空き確認が3回続けて失敗しました: ${msg}`);
  }
}

const lambda = new LambdaClient({});

async function invokeWorker(event: WorkerEvent) {
  await lambda.send(
    new InvokeCommand({ FunctionName: process.env.WORKER_FUNCTION, InvocationType: 'Event', Payload: JSON.stringify(event) }),
  );
}

async function handle(replyToken: string, h: Handled) {
  await reply(replyToken, h.messages);
  if (h.invoke) await invokeWorker(h.invoke);
}

const html = (statusCode: number, body: string): LambdaFunctionURLResult => ({
  statusCode,
  headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  },
  body,
});

export async function webhook(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
  const method = event.requestContext.http.method;

  if (event.rawPath === CREDENTIALS_PATH) {
    const r = await handleCredentialsPage(method, event.queryStringParameters ?? {}, raw);
    if (r.saved) await invokeWorker({ action: 'verify-login' });
    return html(r.statusCode, r.body);
  }

  if (method !== 'POST' || !(await verifySignature(raw, event.headers['x-line-signature']))) {
    return { statusCode: 401, body: 'bad signature' };
  }
  const baseUrl = `https://${event.requestContext.domainName}`;
  for (const e of JSON.parse(raw).events ?? []) {
    try {
      if (e.type === 'message' && e.message?.type === 'text') {
        await handle(e.replyToken, await handleText(e.message.text));
      } else if (e.type === 'postback') {
        const p = parsePostback(e.postback.data);
        if (p) await handle(e.replyToken, await handlePostback(p, baseUrl));
      } else if (e.type === 'follow') {
        await reply(e.replyToken, await welcome());
      }
    } catch (err) {
      console.error(err);
    }
  }
  return { statusCode: 200, body: 'ok' };
}
