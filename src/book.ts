// 空き枠を1件予約する。ログインは .auth/profile に保存した状態を使う（npm run login で手動ログイン）
// パスワードは保存しないし、reCAPTCHA も突破しない。ログインが切れていたら LoginRequired を投げる
//
// 画面の流れ（操作マニュアル「予約申込・確認・取消」より）
//   時間帯別空き状況で枠を選ぶ → 次へ進む →（未ログインなら Login）→ 申込内容入力
//   → 利用目的・利用人数を入れて「申込」→ 確認ダイアログ「はい」→ 予約申込 完了
import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { config } from './config.ts';
import { openDays, showWeek, readDays, openTimes, readTimes, next, settle, type Slot } from './site.ts';

export const PROFILE = '.auth/profile';

export class LoginRequired extends Error {
  constructor() {
    super('予約システムのログインが切れています。npm run login で手動ログインしてください');
  }
}

export type BookResult = { status: 'booked' | 'dry-run'; screenshot: string };

export async function openProfile(headless = true): Promise<BrowserContext> {
  return chromium.launchPersistentContext(PROFILE, { headless, viewport: { width: 1200, height: 900 } });
}

async function shot(page: Page, label: string) {
  mkdirSync('screenshots', { recursive: true });
  const path = `screenshots/${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.png`;
  await page.screenshot({ path, fullPage: true });
  return path;
}

export async function bookSlot(slot: Slot, dryRun: boolean): Promise<BookResult> {
  const context = await openProfile();
  const page = await context.newPage();
  try {
    await openDays(page, [slot.facility]);
    await showWeek(page, slot.date);
    const day = (await readDays(page)).find((c) => c.date === slot.date && c.room === config.dayRow);
    if (!day || (day.status !== 'some' && day.status !== 'vacant')) throw new Error('もう空いていません（日別）');
    await openTimes(page, [day]);

    const cell = (await readTimes(page)).find(
      (t) => t.date === slot.date && t.room === slot.room && t.from === slot.from && t.to === slot.to,
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

    if (dryRun) {
      return { status: 'dry-run', screenshot: await shot(page, 'dry-run') };
    }

    await page.getByRole('button', { name: '申込', exact: true }).click();
    await page.getByRole('button', { name: 'はい', exact: true }).click();
    await page.getByText('完了').first().waitFor({ timeout: 30_000 });
    return { status: 'booked', screenshot: await shot(page, 'booked') };
  } catch (e) {
    await shot(page, 'error').catch(() => {});
    throw e;
  } finally {
    await context.close();
  }
}
