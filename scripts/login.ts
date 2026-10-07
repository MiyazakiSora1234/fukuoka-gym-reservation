// 予約システムに手動でログインして、ログイン状態を .auth/profile に保存する
// ブラウザが開くので、利用者IDとパスワードを自分で入れてログインし、終わったらブラウザを閉じてください
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { BASE } from '../src/site.ts';
import { openProfile } from '../src/book.ts';

const context = await openProfile(false);
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(`${BASE}/Login`);
console.log('ブラウザでログインしてください。終わったらブラウザを閉じると保存されます。');
await new Promise((r) => context.on('close', r));

// 自動予約を再開させる
if (existsSync('state.json')) {
  const state = JSON.parse(readFileSync('state.json', 'utf8'));
  writeFileSync('state.json', JSON.stringify({ ...state, loginNotified: false }, null, 2));
}
