// 福岡市公共施設案内・予約システム（www3.11489.jp/fukuoka）の画面操作
// 画面遷移はサーバー側のセッションで管理されているので、ブラウザの戻る機能は使わず画面上のボタンで進む
import type { Page } from 'playwright';

export const BASE = 'https://www3.11489.jp/fukuoka/user';

export type DayStatus = 'vacant' | 'some' | 'full' | 'receptionClosed' | 'lottery' | 'other';

export interface Slot {
  facility: string; // 例: 市民体育館（個人利用）
  room: string; // 例: バドミントン（2～6名）※1コートのみ
  date: string; // YYYY-MM-DD
  from: string; // HH:MM
  to: string; // HH:MM
}

export function slotKey(s: Slot) {
  return `${s.facility}|${s.room}|${s.date}|${s.from}-${s.to}`;
}

function hhmm(v: string) {
  const n = v.padStart(4, '0');
  return `${n.slice(0, 2)}:${n.slice(2)}`;
}

async function next(page: Page) {
  await page.locator('li.item.next button').click();
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  // Vue の描画待ち。「Loading」表示が消えるまで
  await page.locator('text=Loading').first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
}

/** ホームから施設を選んで「施設別空き状況」画面まで進む */
export async function openDays(page: Page, facilities: string[]) {
  await page.goto(`${BASE}/Home`);
  await page.getByRole('button', { name: 'スポーツ施設（体育館）' }).click();
  await page.waitForURL(/SelectFacility/);
  await settle(page);
  for (const name of facilities) {
    const label = page.locator('label.custom-control-label', { hasText: new RegExp(`^\\s*${escapeRe(name)}\\s*$`) });
    if ((await label.count()) === 0) throw new Error(`施設が見つかりません: ${name}`);
    await label.first().click();
  }
  await next(page);
  await page.waitForURL(/SelectDays/);
  await settle(page);
}

/** 施設別空き状況の表示開始日を変える（1週間分が表示される） */
export async function showWeek(page: Page, startDate: string) {
  await page.locator('#SearchCondition_StartDate').fill(startDate);
  await page.getByRole('button', { name: '表示', exact: true }).click();
  await settle(page);
  await page.waitForFunction(
    (d) => !!document.querySelector(`input[name$=".UseDate"][value^="${d}"]`),
    startDate,
    { timeout: 30_000 },
  );
}

export interface DayCell {
  facility: string;
  room: string;
  date: string;
  status: DayStatus;
  index: number; // ページ内の label.btn-toggle の通し番号（クリック用）
}

/** 施設別空き状況の表を読む */
export async function readDays(page: Page): Promise<DayCell[]> {
  return page.evaluate(() => {
    const out: any[] = [];
    const titles = Array.from(document.querySelectorAll('h3.facility-title'));
    const labels = Array.from(document.querySelectorAll('td label.btn-toggle'));
    for (const [index, label] of labels.entries()) {
      const tr = label.closest('tr')!;
      // 施設名は文書順でこのセルより前にある最後の h3.facility-title
      const h = titles.filter((t) => t.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).pop();
      const cls = label.className;
      const status = ['vacant', 'some', 'full', 'receptionClosed', 'lottery'].find((c) =>
        cls.split(/\s+/).includes(c),
      ) ?? 'other';
      const useDate = (label.querySelector('input[name$=".UseDate"]') as HTMLInputElement | null)?.value ?? '';
      out.push({
        facility: (h?.querySelector('a')?.textContent ?? h?.textContent ?? '').trim(),
        room: (tr.querySelector('td.startdate')?.firstChild?.textContent ?? '').trim(),
        date: useDate.slice(0, 10),
        status,
        index,
      });
    }
    return out;
  });
}

/** 施設別空き状況でセルを選んで「時間帯別空き状況」へ進む */
export async function openTimes(page: Page, cells: DayCell[]) {
  const labels = page.locator('td label.btn-toggle');
  for (const c of cells) await labels.nth(c.index).click();
  await next(page);
  await page.waitForURL(/SelectTime/);
  await settle(page);
}

export interface TimeCell extends Slot {
  status: string; // vacant / full など
  index: number; // ページ内の div.btn-group-toggle の通し番号（クリック用）
}

/** 時間帯別空き状況の表を読む */
export async function readTimes(page: Page): Promise<TimeCell[]> {
  const raw = await page.evaluate(() => {
    const out: any[] = [];
    const titles = Array.from(document.querySelectorAll('h3.facility-title'));
    const cells = Array.from(document.querySelectorAll('li.selection-item div.btn-group-toggle'));
    for (const [index, div] of cells.entries()) {
      const li = div.closest('li.selection-item')!;
      const val = (suffix: string) =>
        (li.querySelector(`input[name$="${suffix}"]`) as HTMLInputElement | null)?.value ?? '';
      const name = (li.querySelector('input[name$=".TimeFrom"]') as HTMLInputElement | null)?.name ?? '';
      // name: AvailabilityTime.FacilityList[f].Days[d].DisplayRows[r].DisplayCells[c].TimeFrom
      const m = name.match(/FacilityList\[(\d+)\]\.Days\[(\d+)\]/);
      const dayPrefix = m ? `AvailabilityTime.FacilityList[${m[1]}].Days[${m[2]}]` : '';
      const useDate =
        (document.querySelector(`input[name="${dayPrefix}.UseDate"]`) as HTMLInputElement | null)?.value ?? '';
      const group = div.closest('li.events-group');
      const room = group?.querySelector('.room-name > span')?.textContent?.trim() ?? '';
      const h = titles.filter((t) => t.compareDocumentPosition(div) & Node.DOCUMENT_POSITION_FOLLOWING).pop();
      const facility = (h?.querySelector('a')?.textContent ?? h?.textContent ?? '').trim();
      const status = ['vacant', 'full'].find((c) => div.classList.contains(c)) ?? div.className;
      out.push({ facility, room, date: useDate.slice(0, 10), from: val('.TimeFrom'), to: val('.TimeTo'), status, index });
    }
    return out;
  });
  return raw.map((r) => ({ ...r, from: hhmm(r.from), to: hhmm(r.to) }));
}

/** 時間帯別空き状況から施設別空き状況へ戻る */
export async function backToDays(page: Page) {
  await page.locator('li.item.prev button').click();
  await page.waitForURL(/SelectDays/);
  await settle(page);
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
