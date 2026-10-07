// 空き枠を1件予約する
// ログインは保存したクッキー（auth.json）を使い、切れていれば SSM に登録した利用者ID・パスワードでログインし直す。
// reCAPTCHA は突破しない。ログインできなければ LoginRequired を投げる
//
// 画面の流れ（操作マニュアル「予約申込・確認・取消」より）
//   時間帯別空き状況で枠を選ぶ → 次へ進む →（未ログインなら Login）→ 申込内容入力
//   → 利用目的・利用人数を入れて「申込」→ 確認ダイアログ「はい」→ 予約申込 完了
import type { Page } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { config } from './config.ts';
import { launchBrowser, onLambda } from './browser.ts';
import { loadJSON, saveJSON } from './store.ts';
import { loadCredentials } from './secrets.ts';
import { BASE, openDays, showWeek, readDays, openTimes, readTimes, next, settle, type Slot } from './site.ts';

export const AUTH_KEY = 'auth.json';

export class LoginRequired extends Error {
  constructor(reason = '予約システムにログインできません') {
    super(`${reason}。LINE の「設定」→「ログイン情報」で利用者IDとパスワードを確かめてください`);
  }
}

export type BookResult = { status: 'booked' | 'dry-run'; summary: string };

async function shot(page: Page, label: string) {
  const dir = onLambda ? '/tmp/screenshots' : 'screenshots';
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.png`, fullPage: true });
}

/** 施設別空き状況 → 時間帯別空き状況で枠を選んで「次へ進む」まで */
async function selectSlot(page: Page, slot: Slot) {
  await openDays(page, [slot.facility]);
  await showWeek(page, slot.date);
  const day = (await readDays(page)).find((c) => c.date === slot.date && c.room === config.dayRow);
  if (!day || (day.status !== 'some' && day.status !== 'vacant')) throw new Error('もう空いていません（日別）');
  await openTimes(page, [day]);

  const cell = (await readTimes(page)).find(
    (t) => t.date === slot.date && t.room.includes(config.sport) && t.from === slot.from && t.to === slot.to,
  );
  if (!cell || cell.status !== 'vacant') throw new Error('もう空いていません（時間帯別）');
  await page.locator('li.selection-item div.btn-group-toggle').nth(cell.index).locator('label').click();
  await next(page);
  await page.waitForURL((u) => !/SelectTime/.test(u.pathname), { timeout: 30_000 });
  await settle(page);
}

async function onInputPage(page: Page) {
  return (await page.title()).startsWith('申込内容入力');
}

/** ログイン画面で利用者ID・パスワードを入れてログインする */
async function login(page: Page) {
  const creds = await loadCredentials();
  if (!creds) throw new LoginRequired('ログイン情報（利用者ID・パスワード）が未登録です');
  await page.locator('#UserLoginInputModel_Id').fill(creds.userId);
  await page.locator('input[name="UserLoginInputModel.Password"]').fill(creds.password);
  await page.locator('button[aria-label="ログイン"].btn-lg').click();
  await page.waitForURL((u) => !/\/Login/i.test(u.pathname), { timeout: 30_000 }).catch(() => {});
  await settle(page);
  if (/\/Login/i.test(page.url())) {
    // 入力したパスワードが画面の記録に残らないよう消してから原因を読む
    await page.locator('input[name="UserLoginInputModel.Password"]').fill('');
    const text = await page.locator('body').innerText();
    const reason = /recaptcha|ロボット/i.test(text) ? 'reCAPTCHA が出たため自動ログインできませんでした' : '自動ログインに失敗しました（IDかパスワードが違う可能性があります）';
    throw new LoginRequired(reason);
  }
}

export async function bookSlot(slot: Slot, dryRun: boolean, people: number): Promise<BookResult> {
  const auth = await loadJSON<{ cookies: any[]; origins: any[] }>(AUTH_KEY, { cookies: [], origins: [] });
  const browser = await launchBrowser();
  const context = await browser.newContext({ storageState: auth, viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  try {
    await selectSlot(page, slot);
    if (/\/Login/i.test(page.url())) {
      await login(page);
      // ログイン後に申込内容入力へ進まなかったら、枠の選択からやり直す
      if (!(await onInputPage(page))) {
        await selectSlot(page, slot);
        if (/\/Login/i.test(page.url())) throw new LoginRequired('ログインしたのに、またログイン画面に戻りました');
      }
    }

    // 申込内容入力
    // 「申込内容入力」はパンくずリストにも出るので、ページのタイトルで判定する
    await page.waitForFunction(() => document.title.startsWith('申込内容入力'), null, { timeout: 30_000 });
    const body = await page.locator('body').innerText();
    if (!body.includes(slot.from.replace(/^0/, '')) && !body.includes(slot.from)) {
      throw new Error('申込内容入力の時間帯が選んだ枠と違います');
    }
    await page.locator('label', { hasText: config.autoBook.purpose ?? config.sport }).first().click();
    const peopleInput = page.locator('input[type="number"], input[name*="Number" i], input[name*="Count" i]').first();
    await peopleInput.fill(String(people));
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

/** 登録したログイン情報でログインできるか確かめる（LINE で登録した直後に使う）。できればクッキーも保存する */
export async function verifyLogin(): Promise<void> {
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`${BASE}/Home`);
    await settle(page);
    await page.getByRole('button', { name: 'ログイン' }).first().click();
    await page.waitForURL(/\/Login/i, { timeout: 30_000 });
    await settle(page);
    await login(page);
    await saveJSON(AUTH_KEY, await context.storageState());
  } catch (e) {
    await shot(page, 'login-error').catch(() => {});
    throw e;
  } finally {
    await browser.close();
  }
}
