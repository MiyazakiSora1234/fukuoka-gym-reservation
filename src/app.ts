// 空き確認・予約・LINE コマンドの本体。PC（watch.ts）と Lambda（lambda.ts）の両方から使う
import { config, matchesWant } from './config.ts';
import { findVacant } from './check.ts';
import { launchBrowser } from './browser.ts';
import { bookSlot, LoginRequired } from './book.ts';
import { loadState, saveState, type State } from './store.ts';
import { notify, send, textMessage, vacancyMessage, formatSlot, type Message } from './notify.ts';
import { BASE, slotKey, type Slot } from './site.ts';

function jstDate(offsetDays = 0) {
  return new Date(Date.now() + 9 * 3600e3 + offsetDays * 864e5).toISOString().slice(0, 10);
}

function autoBookOf(state: State) {
  return { ...config.autoBook, ...state.autoBook };
}

/** 自動予約してよい枠のうち一番早いもの */
function pickToBook(candidates: Slot[], state: State): Slot | undefined {
  const { maxPerMonth, minDaysAhead, dryRun } = autoBookOf(state);
  const earliest = jstDate(minDaysAhead);
  return candidates
    .filter((s) => s.date >= earliest)
    // 同じ日に2枠は取らない
    .filter((s) => !state.booked.some((b) => b.date === s.date))
    .filter((s) => state.booked.filter((b) => b.date.slice(0, 7) === s.date.slice(0, 7)).length < maxPerMonth)
    .filter((s) => !dryRun || !state.dryRuns.includes(slotKey(s)))
    .sort((a, b) => (a.date + a.from).localeCompare(b.date + b.from))[0];
}

/** 空きを確認して、新しい空きを通知し、設定によっては1件自動予約する */
export async function runCheck() {
  const state = await loadState();
  if (state.paused) {
    console.log('停止中なので確認しません');
    return;
  }
  const browser = await launchBrowser();
  let vacant: Slot[];
  try {
    vacant = (await findVacant(browser)).filter((s) => matchesWant(s, config.wants));
  } finally {
    await browser.close();
  }
  const fresh = vacant.filter((s) => !state.notified.includes(slotKey(s)));
  console.log(`${new Date().toLocaleString('ja-JP')} 希望に合う空き ${vacant.length} 件（新規 ${fresh.length} 件）`);
  if (fresh.length) await send([vacancyMessage('🏸 バドミントンの空きが出ました', fresh)]);
  // いま空いている枠だけを覚えておく
  state.notified = vacant.map(slotKey);
  state.vacant = vacant;
  state.lastCheckedAt = new Date().toISOString();
  await saveState(state);

  const auto = autoBookOf(state);
  if (auto.enabled && !state.loginNotified) {
    const slot = pickToBook(vacant, state);
    if (slot) await runBook(slot, false);
  }
}

/** 1件予約する。manual は LINE の「予約する」ボタンから */
export async function runBook(slot: Slot, manual: boolean) {
  const { dryRun } = autoBookOf(await loadState());
  let result: Awaited<ReturnType<typeof bookSlot>> | undefined;
  let error: unknown;
  try {
    result = await bookSlot(slot, dryRun);
  } catch (e) {
    error = e;
  }
  // 予約に時間がかかる間に別の処理が状態を書き換えているかもしれないので読み直してから更新する
  const state = await loadState();
  if (result?.status === 'booked') {
    state.loginNotified = false;
    state.booked.push(slot);
    await notify(
      `✅ 予約しました\n${formatSlot(slot)}\n人数 ${config.autoBook.people}人\n${result.summary}\n\n行けなくなったら前日19時までに取消してください（当日キャンセルは翌月1か月予約停止）\n${BASE}/Home`,
    );
  } else if (result?.status === 'dry-run') {
    state.loginNotified = false;
    if (!manual) state.dryRuns.push(slotKey(slot));
    await notify(
      `🧪 お試しモード: 申込の直前まで進めました（予約はしていません）\n${formatSlot(slot)}\n${result.summary}\n\n本番にするには「本番モード」と送ってください`,
    );
  } else if (error instanceof LoginRequired) {
    if (manual || !state.loginNotified) await notify(`🔑 ${error.message}\n自動予約は止めて、通知だけ続けます`);
    state.loginNotified = true;
  } else {
    await notify(`⚠️ 予約できませんでした\n${formatSlot(slot)}\n${String((error as Error)?.message ?? error).slice(0, 300)}\n${BASE}/Home`);
  }
  await saveState(state);
}

const HELP = `使えるコマンド
・状況 … 今の空きと設定
・止めて ／ 再開 … 空き確認の停止・再開
・自動予約オン ／ 自動予約オフ
・お試しモード ／ 本番モード … 自動予約で最後の「申込」を押すかどうか

空き通知の「予約する」ボタンで、その枠を予約します`;

/** LINE で送られたテキストへの返信を作る。状態を変えるコマンドはここで保存する */
export async function handleCommand(text: string): Promise<Message[]> {
  const state = await loadState();
  const set = async (patch: Partial<State>, msg: string) => {
    await saveState({ ...state, ...patch });
    return [textMessage(msg)];
  };
  const auto = autoBookOf(state);
  switch (text.trim()) {
    case '止めて':
      return set({ paused: true }, '⏸ 空き確認を止めました。「再開」で再開します');
    case '再開':
      return set({ paused: false }, '▶️ 空き確認を再開しました');
    case '自動予約オン':
      return set({ autoBook: { ...state.autoBook, enabled: true } }, `🤖 自動予約をオンにしました（${auto.dryRun ? 'お試しモード' : '本番モード'}）`);
    case '自動予約オフ':
      return set({ autoBook: { ...state.autoBook, enabled: false } }, '自動予約をオフにしました。通知は続けます');
    case 'お試しモード':
      return set({ autoBook: { ...state.autoBook, dryRun: true } }, '🧪 お試しモードにしました。最後の「申込」は押しません');
    case '本番モード':
      return set({ autoBook: { ...state.autoBook, dryRun: false } }, '本番モードにしました。「予約する」ボタンや自動予約で実際に予約します');
    case '状況': {
      const month = jstDate().slice(0, 7);
      const lines = [
        state.paused ? '⏸ 空き確認: 停止中' : '▶️ 空き確認: 動作中',
        `最終確認: ${state.lastCheckedAt ? new Date(state.lastCheckedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : 'まだ'}`,
        `自動予約: ${auto.enabled ? 'オン' : 'オフ'}（${auto.dryRun ? 'お試し' : '本番'}）`,
        `今月の予約: ${state.booked.filter((b) => b.date.startsWith(month)).length}/${auto.maxPerMonth} 件`,
        state.loginNotified ? '🔑 ログイン切れ（PC で npm run login）' : '',
      ].filter(Boolean);
      const msgs: Message[] = [textMessage(lines.join('\n'))];
      if (state.vacant.length) msgs.push(vacancyMessage('いま空いている枠', state.vacant));
      return msgs;
    }
    default:
      return [textMessage(HELP)];
  }
}
