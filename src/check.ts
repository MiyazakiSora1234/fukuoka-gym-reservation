// 指定した施設・期間の空き枠（バドミントン）を集める
import type { Browser } from 'playwright-core';
import { config, matchesWant } from './config.ts';
import { onLambda } from './browser.ts';
import { openDays, showWeek, readDays, openTimes, readTimes, backToDays, type Slot } from './site.ts';

function jstToday() {
  return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
}

function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function findVacant(browser: Browser): Promise<Slot[]> {
  const page = await browser.newPage();
  const found: Slot[] = [];
  try {
    await openDays(page, config.facilities);
    const today = jstToday();
    for (let w = 0; w < config.weeksAhead; w++) {
      await showWeek(page, addDays(today, w * 7));
      const open = (await readDays(page)).filter(
        (c) =>
          (c.status === 'some' || c.status === 'vacant') &&
          c.room === config.dayRow &&
          matchesWant({ date: c.date, from: '00:00', to: '00:00' }, config.wants.map((w) => ({ weekdays: w.weekdays }))),
      );
      // 一度に選べるのは最大10コマまで
      for (let i = 0; i < open.length; i += 10) {
        await openTimes(page, open.slice(i, i + 10));
        for (const t of await readTimes(page)) {
          if (t.status === 'vacant' && t.room.includes(config.roomKeyword)) {
            found.push({ facility: t.facility, room: t.room, date: t.date, from: t.from, to: t.to });
          }
        }
        await backToDays(page);
      }
    }
  } catch (e) {
    // 原因調査用に失敗時の画面を残す
    await page.screenshot({ path: onLambda ? '/tmp/last-error.png' : 'last-error.png', fullPage: true }).catch(() => {});
    throw e;
  } finally {
    await page.close();
  }
  return found;
}
