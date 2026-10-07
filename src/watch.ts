// 定期的に空きを確認して、新しく空いた希望の枠を LINE に通知する
//   node src/watch.ts         … ずっと動かし続ける
//   node src/watch.ts --once  … 1回だけ確認して終わる
import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { config, matchesWant, weekdayOf } from './config.ts';
import { findVacant } from './check.ts';
import { notify } from './notify.ts';
import { BASE, slotKey, type Slot } from './site.ts';

const STATE = 'state.json';
interface State {
  /** 通知済みの枠。空きが埋まったら消して、また空いたら再通知する */
  notified: string[];
}

function load(): State {
  return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { notified: [] };
}

function format(s: Slot) {
  return `${s.date.slice(5).replace('-', '/')}(${weekdayOf(s.date)}) ${s.from}-${s.to} ${s.facility.replace('（個人利用）', '')}`;
}

async function checkOnce() {
  const browser = await chromium.launch();
  try {
    const vacant = (await findVacant(browser)).filter((s) => matchesWant(s, config.wants));
    const state = load();
    const now = new Set(vacant.map(slotKey));
    const fresh = vacant.filter((s) => !state.notified.includes(slotKey(s)));
    console.log(`${new Date().toLocaleString('ja-JP')} 希望に合う空き ${vacant.length} 件（新規 ${fresh.length} 件）`);
    if (fresh.length) {
      await notify(`🏸 バドミントンの空きが出ました\n${fresh.map(format).join('\n')}\n\n予約はこちら: ${BASE}/Home`);
    }
    // いま空いている枠だけを覚えておく
    writeFileSync(STATE, JSON.stringify({ notified: [...now] }, null, 2));
  } finally {
    await browser.close();
  }
}

function jstHour() {
  return new Date(Date.now() + 9 * 3600e3).getUTCHours();
}

const once = process.argv.includes('--once');
let failures = 0;
while (true) {
  const [qs, qe] = config.quietHours;
  const h = jstHour();
  if (!once && h >= qs && h < qe) {
    console.log(`${h}時は確認しない時間帯なので待ちます`);
  } else {
    try {
      await checkOnce();
      failures = 0;
    } catch (e) {
      failures++;
      console.error(e);
      // サイトの仕様変更などで失敗し続けている場合だけ知らせる
      if (failures === 3) await notify(`⚠️ 空き確認が3回続けて失敗しました: ${(e as Error).message.slice(0, 300)}`);
    }
  }
  if (once) break;
  // 毎回同じ間隔にならないよう ±20% ずらす
  const wait = config.intervalMinutes * 60e3 * (0.8 + Math.random() * 0.4);
  await new Promise((r) => setTimeout(r, wait));
}
