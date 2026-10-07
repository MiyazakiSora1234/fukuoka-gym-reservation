// 空き確認・予約・LINE の操作の本体。PC（watch.ts）と Lambda（lambda.ts）の両方から使う
import { config, matchesWant, type Want } from './config.ts';
import { findVacant } from './check.ts';
import { launchBrowser } from './browser.ts';
import { bookSlot, verifyLogin, LoginRequired } from './book.ts';
import { createCredentialsLink, LINK_MINUTES } from './web.ts';
import { loadState, saveState, type State } from './store.ts';
import {
  notify,
  send,
  textMessage,
  vacancyMessage,
  confirmMessage,
  settingsMessage,
  conditionsMessage,
  bookedMessage,
  credentialsLinkMessage,
  formatSlot,
  shortName,
  HELP,
  type Message,
  type Postback,
} from './line.ts';
import { BASE, slotKey, type Slot } from './site.ts';

/** LINE の「条件」で選べる探し方 */
export const PRESETS: { id: string; label: string; wants: Want[] }[] = [
  { id: 'default', label: '土日＋平日夜', wants: config.wants },
  { id: 'weekend', label: '土日だけ', wants: [{ weekdays: ['土', '日'] }] },
  { id: 'weeknight', label: '平日の夜', wants: [{ weekdays: ['月', '火', '水', '木', '金'], from: '17:00' }] },
  { id: 'any', label: 'いつでも', wants: [{}] },
];

function jstDate(offsetDays = 0) {
  return new Date(Date.now() + 9 * 3600e3 + offsetDays * 864e5).toISOString().slice(0, 10);
}

const autoBookOf = (state: State) => ({ ...config.autoBook, ...state.autoBook });
const presetOf = (state: State) => PRESETS.find((p) => p.id === state.preset) ?? PRESETS[0];
const peopleOf = (state: State) => state.people ?? config.autoBook.people;
const facilitiesOf = (state: State) =>
  (state.facilities ?? config.defaultFacilities).filter((f) => config.facilities.includes(f));
const upcoming = (state: State) => state.booked.filter((b) => b.date >= jstDate()).sort((a, b) => slotKey(a).localeCompare(slotKey(b)));

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

/**
 * 空きを確認して、新しい空きを通知し、設定によっては1件自動予約する。
 * report は LINE の「今すぐ確認」から。新しい空きがなくても結果を返す
 */
export async function runCheck({ report = false } = {}) {
  const state = await loadState();
  if (state.paused && !report) {
    console.log('停止中なので確認しません');
    return;
  }
  const wants = presetOf(state).wants;
  const browser = await launchBrowser();
  let vacant: Slot[];
  try {
    vacant = (await findVacant(browser, wants, facilitiesOf(state))).filter((s) => matchesWant(s, wants));
  } finally {
    await browser.close();
  }
  const fresh = vacant.filter((s) => !state.notified.includes(slotKey(s)));
  console.log(`${new Date().toLocaleString('ja-JP')} 希望に合う空き ${vacant.length} 件（新規 ${fresh.length} 件）`);
  if (fresh.length) await send([vacancyMessage(`🏟️ ${config.sport}の空きが出ました`, fresh)]);
  else if (report && vacant.length) await send([vacancyMessage('いま空いている枠', vacant)]);
  else if (report) await notify(`🔍 確認しました。「${presetOf(state).label}」に合う空きは今はありません。空きが出たらお知らせします`);
  // いま空いている枠だけを覚えておく
  state.notified = vacant.map(slotKey);
  state.vacant = vacant;
  state.lastCheckedAt = new Date().toISOString();
  await saveState(state);

  const auto = autoBookOf(state);
  if (auto.enabled && !state.paused && !state.loginNotified) {
    const slot = pickToBook(vacant, state);
    if (slot) await runBook(slot, false);
  }
}

/** 1件予約する。manual は LINE の「予約する」ボタンから */
export async function runBook(slot: Slot, manual: boolean) {
  const before = await loadState();
  const { dryRun } = autoBookOf(before);
  const people = peopleOf(before);
  let result: Awaited<ReturnType<typeof bookSlot>> | undefined;
  let error: unknown;
  try {
    result = await bookSlot(slot, dryRun, people);
  } catch (e) {
    error = e;
  }
  // 予約に時間がかかる間に別の処理が状態を書き換えているかもしれないので読み直してから更新する
  const state = await loadState();
  const how = manual ? '' : '（自動予約）';
  if (result?.status === 'booked') {
    state.loginNotified = false;
    state.booked.push(slot);
    await notify(
      `✅ 予約しました${how}\n${formatSlot(slot)}\n${config.sport}・${people}人\n${result.summary}\n\n行けなくなったら前日19時までに予約システムで取消してください（当日キャンセルは翌月1か月予約停止）`,
    );
  } else if (result?.status === 'dry-run') {
    state.loginNotified = false;
    if (!manual) state.dryRuns.push(slotKey(slot));
    await notify(
      `🧪 お試し${how}: 申込の直前まで進めました（予約はしていません）\n${formatSlot(slot)}\n${result.summary}\n\n実際に予約するには「設定」で本番にしてください`,
    );
  } else if (error instanceof LoginRequired) {
    if (manual || !state.loginNotified) await notify(`🔑 ${error.message}\n自動予約は止めて、通知だけ続けます`);
    state.loginNotified = true;
  } else {
    await notify(`⚠️ 予約できませんでした${how}\n${formatSlot(slot)}\n${String((error as Error)?.message ?? error).slice(0, 300)}\n${BASE}/Home`);
  }
  await saveState(state);
}

function statusMessages(state: State): Message[] {
  const auto = autoBookOf(state);
  const month = jstDate().slice(0, 7);
  const last = state.lastCheckedAt
    ? new Date(state.lastCheckedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'まだ';
  const lines = [
    state.paused ? '⏸ 空き確認は停止中です（「設定」で再開）' : `▶️ 10分ごとに確認中（最終 ${last}）`,
    `条件: ${presetOf(state).label}・${peopleOf(state)}人`,
    `体育館: ${facilitiesOf(state).map(shortName).join('・')}`,
    ...(state.credentialsSet ? [] : ['🔑 予約するには「設定」でログイン情報を登録してください']),
    `自動予約: ${auto.enabled ? 'オン' : 'オフ'}（${auto.dryRun ? 'お試し' : '本番'}）`,
    `今月の予約: ${state.booked.filter((b) => b.date.startsWith(month)).length}/${auto.maxPerMonth} 件`,
    ...(state.loginNotified ? ['🔑 予約システムにログインできていません'] : []),
  ];
  const msgs = [textMessage(lines.join('\n'))];
  msgs.push(state.vacant.length ? vacancyMessage('いま空いている枠', state.vacant) : textMessage('いま条件に合う空きはありません'));
  return msgs;
}

function settingsOf(state: State) {
  const auto = autoBookOf(state);
  return settingsMessage({
    paused: state.paused,
    autoEnabled: auto.enabled,
    dryRun: auto.dryRun,
    loginProblem: state.loginNotified,
    credentialsSet: !!state.credentialsSet,
  });
}

const conditionsOf = (state: State) => conditionsMessage(PRESETS, presetOf(state).id, peopleOf(state), facilitiesOf(state));

/** LINE の操作への返信。worker に回す処理があれば invoke で返す */
export interface Handled {
  messages: Message[];
  invoke?: { action: 'check'; report: true } | { action: 'book'; slot: Slot } | { action: 'verify-login' };
}

/** LINE で送られたテキスト（リッチメニューのボタンもテキストで届く） */
export async function handleText(input: string): Promise<Handled> {
  const state = await loadState();
  const update = async (patch: Partial<State>) => {
    Object.assign(state, patch);
    await saveState(state);
  };
  switch (input.trim()) {
    case '空き状況':
    case '状況':
      return { messages: statusMessages(state) };
    case '今すぐ確認':
      return {
        messages: [textMessage('🔍 空きを確認しています。30秒〜1分ほどで結果を送ります')],
        invoke: { action: 'check', report: true },
      };
    case '予約一覧':
      return { messages: [bookedMessage(upcoming(state))] };
    case '条件':
      return { messages: [conditionsOf(state)] };
    case '設定':
      return { messages: [settingsOf(state)] };
    // 以前のコマンドも使えるようにしておく
    case '止めて':
      await update({ paused: true });
      return { messages: [settingsOf(state)] };
    case '再開':
      await update({ paused: false });
      return { messages: [settingsOf(state)] };
    case '自動予約オン':
    case '自動予約オフ':
      await update({ autoBook: { ...state.autoBook, enabled: input.trim() === '自動予約オン' } });
      return { messages: [settingsOf(state)] };
    case 'お試しモード':
    case '本番モード':
      await update({ autoBook: { ...state.autoBook, dryRun: input.trim() === 'お試しモード' } });
      return { messages: [settingsOf(state)] };
    default:
      return { messages: [textMessage(HELP)] };
  }
}

/** ボタン（postback）の操作。baseUrl はこの Lambda の関数URL（ログイン情報の入力ページに使う） */
export async function handlePostback(p: Postback, baseUrl: string): Promise<Handled> {
  const state = await loadState();
  const auto = autoBookOf(state);
  const update = async (patch: Partial<State>) => {
    Object.assign(state, patch);
    await saveState(state);
  };
  switch (p.kind) {
    case 'ask':
      if (p.slot.date < jstDate()) return { messages: [textMessage('この枠はもう過ぎています')] };
      return { messages: [confirmMessage(p.slot, peopleOf(state), auto.dryRun)] };
    case 'book':
      if (!state.credentialsSet) {
        return {
          messages: [
            textMessage('予約するには、先に予約システムのログイン情報を登録してください'),
            credentialsLinkMessage(await createCredentialsLink(baseUrl), LINK_MINUTES),
          ],
        };
      }
      if (state.booked.some((b) => slotKey(b) === slotKey(p.slot))) {
        return { messages: [textMessage(`${formatSlot(p.slot)} はもう予約済みです`)] };
      }
      return {
        messages: [textMessage(`⏳ ${formatSlot(p.slot)} の予約を進めています。1分ほどで結果を送ります`)],
        invoke: { action: 'book', slot: p.slot },
      };
    case 'cancel':
      return { messages: [textMessage('やめました')] };
    case 'preset': {
      const preset = PRESETS.find((x) => x.id === p.id);
      if (!preset) return { messages: [conditionsOf(state)] };
      // 条件が変わったら、今の空きを新しい条件で通知し直す
      await update({ preset: preset.id, notified: [], vacant: [] });
      return {
        messages: [textMessage(`📅 「${preset.label}」で探します。今の空きを確認します`)],
        invoke: { action: 'check', report: true },
      };
    }
    case 'people':
      if (p.n >= 2 && p.n <= 6) await update({ people: p.n });
      return { messages: [conditionsOf(state)] };
    case 'facility': {
      const current = facilitiesOf(state);
      const next = current.includes(p.facility) ? current.filter((f) => f !== p.facility) : [...current, p.facility];
      if (!next.length) return { messages: [textMessage('体育館は1つ以上選んでください'), conditionsOf(state)] };
      // 施設が変わったら、今の空きを新しい施設で通知し直す
      await update({ facilities: config.facilities.filter((f) => next.includes(f)), notified: [], vacant: [] });
      return { messages: [conditionsOf(state)] };
    }
    case 'creds':
      return { messages: [credentialsLinkMessage(await createCredentialsLink(baseUrl), LINK_MINUTES)] };
    case 'toggle':
      if (p.key === 'paused') await update({ paused: !state.paused });
      if (p.key === 'auto') {
        if (!auto.enabled && !state.credentialsSet) {
          return { messages: [textMessage('自動予約の前に「ログイン情報」を登録してください'), settingsOf(state)] };
        }
        await update({ autoBook: { ...state.autoBook, enabled: !auto.enabled } });
      }
      if (p.key === 'dryRun') await update({ autoBook: { ...state.autoBook, dryRun: !auto.dryRun } });
      return { messages: [settingsOf(state)] };
  }
}

/** ログイン情報を登録した直後に、実際にログインできるか確かめて知らせる */
export async function runVerifyLogin() {
  try {
    await verifyLogin();
    await saveState({ ...(await loadState()), credentialsSet: true, loginNotified: false });
    await notify('✅ 予約システムにログインできました。「予約する」ボタンで予約できます');
  } catch (e) {
    await saveState({ ...(await loadState()), loginNotified: true });
    await notify(`⚠️ ${e instanceof LoginRequired ? e.message : `ログインを確かめられませんでした: ${(e as Error).message.slice(0, 200)}`}`);
  }
}

export async function welcome(): Promise<Message[]> {
  return [textMessage(HELP), settingsOf(await loadState())];
}
