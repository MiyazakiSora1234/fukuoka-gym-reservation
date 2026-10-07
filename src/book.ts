// 空き枠を1件予約する。ログインは npm run login で手動で行い、保存したクッキー（auth.json）を使う
// パスワードは保存しないし、reCAPTCHA も突破しない。ログインが切れていたら LoginRequired を投げる
//
// 画面の流れ（操作マニュアル「予約申込・確認・取消」より）
//   時間帯別空き状況で枠を選ぶ → 次へ進む →（未ログインなら Login）→ 申込内容入力
//   → 利用目的・利用人数を入れて「申込」→ 確認ダイアログ「はい」→ 予約申込 完了
import type { Page } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { config } from './config.ts';
import { launchBrowser, onLambda } from './browser.ts';
import { loadJSON, saveJSON } from './store.ts';
import { openDays, showWeek, readDays, openTimes, readTimes, next, settle, type Slot } from './site.ts';

export const AUTH_KEY = 'auth.json';

export class LoginRequired extends Error {
  constructor() {
    super('予約システムのログインが切れています。PC で npm run login をしてください');
  }
}

export type BookResult = { status: 'booked' | 'dry-run'; summary: string };

async function shot(page: Page, label: string) {
  const dir = onLambda ? '/tmp/screenshots' : 'screenshots';
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.png`, fullPage: true });
}

export async function bookSlot(slot: Slot, dryRun: boolean): Promise<BookResult> {
  const auth = await loadJSON<{ cookies: any[]; origins: any[] }>(AUTH_KEY, { cookies: [], origins: [] });
  if (!auth.cookies.length) throw new LoginRequired();
  const browser = await launchBrowser();
  const context = await browser.newContext({ storageState: auth, viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  try {
    await openDays(page, [slot.facility]);
    await showWeek(page, slot.date);
    const day = (await readDays(page)).find((c) => c.date === slot.date && c.room === config.dayRow);
    if (!day || (day.status !== 'some' && day.status !== 'vacant')) throw new Error('もう空いていません（日別）');
    await openTimes(page, [day]);

    const cell = (await readTimes(page)).find(
      (t) => t.date === slot.date && t.room.includes(config.roomKeyword) && t.from === slot.from && t.to === slot.to,
    );
    if (!cell || cell.status !== 'vacant') throw new Error('もう空いていません（時間帯別）');
    await page.locator('li.selection-item div.btn-group-toggle').nth(cell.index).locator('label').click();
    await next(page);
    await page.waitForURL((u) => !/SelectTime/.test(u.pathname), { timeout: 30_000 });
    await settle(page);
    if (/\/Login/i.test(page.url())) throw new LoginRequired();

    // 申込内容入力
    await page.getByText('申込内容入力').first().waitFor({ timeout: 30_000 });
    const body = await page.locator('body').innerText();
    if (!body.includes(slot.from.replace(/^0/, '')) && !body.includes(slot.from)) {
      throw new Error('申込内容入力の時間帯が選んだ枠と違います');
    }
    await page.locator('label', { hasText: config.autoBook.purpose }).first().click();
    const people = page.locator('input[type="number"], input[name*="Number" i], input[name*="Count" i]').first();
    await people.fill(String(config.autoBook.people));
    // 画面に出ている申込内容（利用日・時間帯・施設・使用料）を結果として返す
    const summary = (await page.locator('body').innerText())
      .split('\n')
      .filter((l) => /\d{4}\/\d{1,2}\/\d{1,2}|円/.test(l))
      .slice(0, 4)
      .join('\n');

    if (dryRun) {
      await shot(page, 'dry-run');
      return { status: 'dry-run', summary };
    }

    await page.getByRole('button', { name: '申込', exact: true }).click();
    await page.getByRole('button', { name: 'はい', exact: true }).click();
    await page.getByText('完了').first().waitFor({ timeout: 30_000 });
    await shot(page, 'booked');
    return { status: 'booked', summary };
  } catch (e) {
    await shot(page, 'error').catch(() => {});
    throw e;
  } finally {
    // ログイン状態が延長されていれば保存し直す
    if (!/\/Login/i.test(page.url())) await saveJSON(AUTH_KEY, await context.storageState()).catch(() => {});
    await browser.close();
  }
}
