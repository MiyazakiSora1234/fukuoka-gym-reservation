// 定期的に空きを確認して、新しく空いた希望の枠を LINE に通知する。autoBook.enabled なら1件ずつ自動予約もする
//   node src/watch.ts         … ずっと動かし続ける
//   node src/watch.ts --once  … 1回だけ確認して終わる
import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { config, matchesWant, weekdayOf } from './config.ts';
import { findVacant } from './check.ts';
import { notify } from './notify.ts';
import { bookSlot, LoginRequired } from './book.ts';
import { BASE, slotKey, type Slot } from './site.ts';

const STATE = 'state.json';
interface State {
  /** 通知済みの枠。空きが埋まったら消して、また空いたら再通知する */
  notified: string[];
  /** 自動予約した枠（お試しモードの分は含めない） */
  booked: Slot[];
  /** お試しモードで処理済みの枠。同じ枠を何度も試さない */
  dryRuns: string[];
  /** ログイン切れを通知済みか。npm run login 後に予約が通ったら戻す */
  loginNotified: boolean;
}

function load(): State {
  const s = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
  return { notified: [], booked: [], dryRuns: [], loginNotified: false, ...s };
}

function format(s: Slot) {
  return `${s.date.slice(5).replace('-', '/')}(${weekdayOf(s.date)}) ${s.from}-${s.to} ${s.facility.replace('（個人利用）', '')}`;
}

function jstDate(offsetDays = 0) {
  return new Date(Date.now() + 9 * 3600e3 + offsetDays * 864e5).toISOString().slice(0, 10);
}

/** 自動予約してよい枠のうち一番早いもの */
function pickToBook(candidates: Slot[], state: State): Slot | undefined {
  const { maxPerMonth, minDaysAhead, dryRun } = config.autoBook;
  const earliest = jstDate(minDaysAhead);
  return candidates
    .filter((s) => s.date >= earliest)
    // 同じ日に2枠は取らない
    .filter((s) => !state.booked.some((b) => b.date === s.date))
    .filter((s) => state.booked.filter((b) => b.date.slice(0, 7) === s.date.slice(0, 7)).length < maxPerMonth)
    .filter((s) => !dryRun || !state.dryRuns.includes(slotKey(s)))
    .sort((a, b) => (a.date + a.from).localeCompare(b.date + b.from))[0];
}

async function tryBook(vacant: Slot[], state: State) {
  const slot = pickToBook(vacant, state);
  if (!slot) return;
  const { dryRun } = config.autoBook;
  try {
    const r = await bookSlot(slot, dryRun);
    state.loginNotified = false;
    if (r.status === 'booked') {
      state.booked.push(slot);
      await notify(`✅ 予約しました\n${format(slot)}\n人数 ${config.autoBook.people}人\n\n行けなくなったら前日19時までに取消してください（当日キャンセルは翌月1か月予約停止）\n${BASE}/Home`);
    } else {
      state.dryRuns.push(slotKey(slot));
      await notify(`🧪 お試しモード: 申込の直前まで進めました（予約はしていません）\n${format(slot)}\n画面: ${r.screenshot}`);
    }
  } catch (e) {
    if (e instanceof LoginRequired) {
      if (!state.loginNotified) await notify(`🔑 ${e.message}\n自動予約は止めて、通知だけ続けます`);
      state.loginNotified = true;
    } else {
      await notify(`⚠️ 自動予約に失敗しました（手動で予約してください）\n${format(slot)}\n${(e as Error).message.slice(0, 300)}`);
    }
  }
}

async function checkOnce() {
  const browser = await chromium.launch();
  let vacant: Slot[];
  try {
    vacant = (await findVacant(browser)).filter((s) => matchesWant(s, config.wants));
  } finally {
    await browser.close();
  }
  const state = load();
  const fresh = vacant.filter((s) => !state.notified.includes(slotKey(s)));
  console.log(`${new Date().toLocaleString('ja-JP')} 希望に合う空き ${vacant.length} 件（新規 ${fresh.length} 件）`);
  if (fresh.length) {
    await notify(`🏸 バドミントンの空きが出ました\n${fresh.map(format).join('\n')}\n\n予約はこちら: ${BASE}/Home`);
  }
  // いま空いている枠だけを覚えておく
  state.notified = vacant.map(slotKey);
  if (config.autoBook.enabled && !state.loginNotified) await tryBook(vacant, state);
  writeFileSync(STATE, JSON.stringify(state, null, 2));
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
