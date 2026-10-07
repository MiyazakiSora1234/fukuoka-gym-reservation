// 予約システムに手動でログインして、ログイン状態（クッキー）を保存する
// .env に STATE_BUCKET があれば S3（クラウド）、なければ .data/ に保存する
// ブラウザが開くので、利用者IDとパスワードを自分で入れてログインし、終わったらブラウザを閉じてください
import 'dotenv/config';
import { chromium } from 'playwright';
import { useAwsLogin } from './aws-env.ts';

// S3 に保存するときは aws login の認証情報を使う
if (process.env.STATE_BUCKET) useAwsLogin();
const { BASE } = await import('../src/site.ts');
const { AUTH_KEY } = await import('../src/book.ts');
const { loadState, saveJSON, saveState } = await import('../src/store.ts');

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: null });
const page = await context.newPage();
await page.goto(`${BASE}/Login`);
console.log('ブラウザでログインしてください。ログインできたら自動で保存して閉じます。');

// ログイン画面から別の画面に移ったらログイン完了とみなす
await page.waitForURL((u) => !/\/Login/i.test(u.pathname), { timeout: 10 * 60e3 });
await page.waitForLoadState('networkidle');
await saveJSON(AUTH_KEY, await context.storageState());
await browser.close();

// 自動予約を再開させる
await saveState({ ...(await loadState()), loginNotified: false });
console.log(`ログイン状態を保存しました（${process.env.STATE_BUCKET ? 'S3' : '.data/'}）`);
