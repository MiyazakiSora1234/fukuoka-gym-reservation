// 予約システムの利用者ID・パスワードを入力するページ（webhook の関数URLで配信する）
// LINE の「設定」→「ログイン情報」で、数分だけ・1回だけ使えるリンクを発行する。
// パスワードは LINE のトークを通らず、このページから SSM（SecureString）に直接保存する
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { loadJSON, saveJSON } from './store.ts';
import { saveCredentials } from './secrets.ts';

export const LINK_MINUTES = 10;
const TOKEN_KEY = 'credentials-link.json';
export const CREDENTIALS_PATH = '/credentials';

interface LinkToken {
  token: string;
  expiresAt: number;
}

export async function createCredentialsLink(baseUrl: string) {
  const token = randomBytes(24).toString('base64url');
  await saveJSON(TOKEN_KEY, { token, expiresAt: Date.now() + LINK_MINUTES * 60e3 } satisfies LinkToken);
  return `${baseUrl.replace(/\/$/, '')}${CREDENTIALS_PATH}?t=${token}`;
}

async function validToken(token: string | undefined) {
  const saved = await loadJSON<LinkToken>(TOKEN_KEY, { token: '', expiresAt: 0 });
  if (!token || !saved.token || saved.expiresAt < Date.now()) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(saved.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(body: string) {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>ログイン情報の登録</title>
<style>
  body { margin: 0; font-family: system-ui, -apple-system, 'Hiragino Sans', sans-serif; background: #f4f6f5; color: #1d2b22; }
  main { max-width: 420px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 20px; }
  label { display: block; margin: 16px 0 6px; font-weight: 600; }
  input { width: 100%; box-sizing: border-box; font-size: 16px; padding: 12px; border: 1px solid #c8d0cb; border-radius: 8px; }
  button { margin-top: 24px; width: 100%; font-size: 16px; padding: 14px; border: 0; border-radius: 8px; background: #06c755; color: #fff; font-weight: 700; }
  p { line-height: 1.6; } .note { font-size: 13px; color: #5d6b63; } .error { color: #d93025; }
</style></head><body><main>${body}</main></body></html>`;
}

function form(token: string, error = '') {
  return page(`<h1>🔑 ログイン情報の登録</h1>
<p class="note">福岡市公共施設案内・予約システムの利用者IDとパスワードを入力してください。AWS に暗号化して保存し、予約するときのログインだけに使います。</p>
${error ? `<p class="error">${escape(error)}</p>` : ''}
<form method="post" action="${CREDENTIALS_PATH}" autocomplete="off">
  <input type="hidden" name="t" value="${escape(token)}">
  <label for="id">利用者ID</label>
  <input id="id" name="id" inputmode="latin" autocapitalize="off" spellcheck="false" required pattern="[a-zA-Z0-9\\-]+">
  <p class="note">メールアドレスではなく、利用者登録で発行された半角英数字のIDです</p>
  <label for="pw">パスワード</label>
  <input id="pw" name="pw" type="password" required>
  <button type="submit">登録する</button>
</form>`);
}

const done = (title: string, msg: string) => page(`<h1>${title}</h1><p>${msg}</p><p class="note">このページを閉じて LINE に戻ってください。</p>`);

export interface WebResult {
  statusCode: number;
  body: string;
  /** 登録できたら true（呼び出し側でログインを確かめる） */
  saved?: boolean;
}

export async function handleCredentialsPage(method: string, query: Record<string, string | undefined>, body: string): Promise<WebResult> {
  if (method === 'GET') {
    if (!(await validToken(query.t))) {
      return { statusCode: 403, body: done('リンクが無効です', `リンクの期限（${LINK_MINUTES}分）が切れたか、もう使われています。LINE の「設定」→「ログイン情報」からもう一度開いてください。`) };
    }
    return { statusCode: 200, body: form(query.t!) };
  }
  if (method === 'POST') {
    const f = new URLSearchParams(body);
    const token = f.get('t') ?? '';
    if (!(await validToken(token))) {
      return { statusCode: 403, body: done('リンクが無効です', 'LINE の「設定」→「ログイン情報」からもう一度開いてください。') };
    }
    const userId = (f.get('id') ?? '').trim();
    const password = f.get('pw') ?? '';
    if (!/^[a-zA-Z0-9-]+$/.test(userId)) return { statusCode: 400, body: form(token, '利用者IDは半角英数字とハイフンです（メールアドレスではありません）') };
    if (!password) return { statusCode: 400, body: form(token, 'パスワードを入力してください') };
    await saveCredentials({ userId, password });
    // リンクは1回だけ
    await saveJSON(TOKEN_KEY, { token: '', expiresAt: 0 } satisfies LinkToken);
    return { statusCode: 200, saved: true, body: done('✅ 登録しました', '実際にログインできるか確かめて、1分ほどで LINE に結果を送ります。') };
  }
  return { statusCode: 405, body: 'method not allowed' };
}
