// 予約の流れを記録する。ブラウザが開くので、手動でログインして予約の手前まで進めてください。
// 画面が切り替わるたびに record/ に HTML とスクリーンショットを保存します。
// 最後の「申込」確定ボタンは押さずに、ブラウザを閉じて終了してください。
// ログイン状態は .auth/ に保存され、自動予約でもそのまま使います。
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { BASE } from '../src/site.ts';

mkdirSync('record', { recursive: true });
const context = await chromium.launchPersistentContext('.auth/profile', { headless: false, viewport: null });
const page = context.pages()[0] ?? (await context.newPage());
let n = 0;
let busy = Promise.resolve();

async function save() {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1000);
  n++;
  const name = `record/${String(n).padStart(2, '0')}-${new URL(page.url()).pathname.split('/').pop()}`;
  // 入力済みのパスワードが HTML に残らないよう消してから保存する
  const html = await page.evaluate(() => {
    const doc = document.documentElement.cloneNode(true) as HTMLElement;
    doc.querySelectorAll('input[type=password]').forEach((i) => i.removeAttribute('value'));
    return doc.outerHTML;
  });
  writeFileSync(`${name}.html`, html);
  await page.screenshot({ path: `${name}.png`, fullPage: true });
  console.log(`保存: ${name}  (${page.url()})`);
}

page.on('framenavigated', (f) => {
  if (f === page.mainFrame()) busy = busy.then(save).catch((e) => console.error(e.message));
});
await page.goto(`${BASE}/Home`);
console.log('ブラウザで操作してください。終わったらブラウザを閉じると終了します。');
await new Promise((r) => context.on('close', r));
await busy.catch(() => {});
