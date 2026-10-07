// LINE Messaging API とメッセージの見た目
// （LINE Notify は 2025年3月で終了したため Messaging API を使う）
// LINE_USER_ID があればその人にプッシュ、なければ公式アカウントの友だち全員にブロードキャストする。
// 自分専用の公式アカウントなら、どちらでも届くのは自分だけ
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config, env, weekdayOf } from './config.ts';
import { BASE, type Slot } from './site.ts';

export type Message = Record<string, unknown>;

const GREEN = '#06C755';
const GRAY = '#888888';

async function call(path: string, body: unknown) {
  const res = await fetch(`https://api.line.me/v2/bot/message/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.lineToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error(`LINE 送信失敗: ${res.status} ${await res.text()}`);
}

export async function send(messages: Message[]) {
  if (!env.lineToken) {
    console.warn('LINE_CHANNEL_ACCESS_TOKEN が未設定なので LINE には送りません');
    return;
  }
  if (env.lineUserId) await call('push', { to: env.lineUserId, messages });
  else await call('broadcast', { messages });
}

/** Webhook の返信。プッシュと違って無料プランの通数に数えられない */
export async function reply(replyToken: string, messages: Message[]) {
  await call('reply', { replyToken, messages: messages.slice(0, 5) });
}

export async function notify(text: string) {
  console.log(`[通知] ${text}`);
  await send([textMessage(text)]);
}

/** リッチメニューと同じ項目。メッセージの下にも出して、どこからでも操作できるようにする */
export const MENU = ['空き状況', '今すぐ確認', '予約一覧', '条件', '設定', 'ヘルプ'] as const;

const quickReply = {
  items: MENU.map((c) => ({ type: 'action', action: { type: 'message', label: c, text: c } })),
};

export function textMessage(text: string): Message {
  return { type: 'text', text: text.slice(0, 5000), quickReply };
}

export function formatSlot(s: Slot) {
  return `${s.date.slice(5).replace('-', '/')}(${weekdayOf(s.date)}) ${s.from}-${s.to} ${s.facility.replace('（個人利用）', '')}`;
}

// ---- postback データ（300文字制限があるので施設は config.facilities の番号で持つ） ----

export type Postback =
  | { kind: 'ask' | 'book'; slot: Slot }
  | { kind: 'cancel' }
  | { kind: 'preset'; id: string }
  | { kind: 'people'; n: number }
  | { kind: 'toggle'; key: 'paused' | 'auto' | 'dryRun' };

function slotData(kind: 'ask' | 'book', s: Slot) {
  return `${kind}|${config.facilities.indexOf(s.facility)}|${s.date}|${s.from}|${s.to}`;
}

export function parsePostback(data: string): Postback | undefined {
  const [kind, ...a] = data.split('|');
  switch (kind) {
    case 'ask':
    case 'book': {
      const facility = config.facilities[Number(a[0])];
      if (!facility) return undefined;
      return { kind, slot: { facility, room: config.sport, date: a[1], from: a[2], to: a[3] } };
    }
    case 'cancel':
      return { kind };
    case 'preset':
      return { kind, id: a[0] };
    case 'people':
      return { kind, n: Number(a[0]) };
    case 'toggle':
      return ['paused', 'auto', 'dryRun'].includes(a[0]) ? { kind, key: a[0] as 'paused' } : undefined;
  }
  return undefined;
}

// ---- Flex メッセージの部品 ----

const text = (t: string, extra: Record<string, unknown> = {}) => ({ type: 'text', text: t, wrap: true, ...extra });

function button(label: string, action: Record<string, unknown>, primary = true) {
  return { type: 'button', style: primary ? 'primary' : 'secondary', color: primary ? GREEN : undefined, height: 'sm', action: { label, ...action } };
}

const postback = (data: string, displayText?: string) => ({ type: 'postback', data, ...(displayText ? { displayText } : {}) });

function bubble(title: string, contents: unknown[], footer?: unknown[]): Message {
  return {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [text(title, { weight: 'bold', size: 'md' }), { type: 'separator' }, ...contents],
    },
    ...(footer ? { footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer } } : {}),
  };
}

function flex(altText: string, contents: Message): Message {
  return { type: 'flex', altText: altText.slice(0, 400), contents, quickReply };
}

/** 空き枠の一覧。1枠ごとに「予約する」ボタン（押すと確認が出る） */
export function vacancyMessage(title: string, slots: Slot[]): Message {
  const shown = slots.slice(0, 10);
  const rows = shown.map((s) => ({
    type: 'box',
    layout: 'horizontal',
    alignItems: 'center',
    spacing: 'sm',
    contents: [
      text(formatSlot(s), { size: 'sm', flex: 3 }),
      { ...button('予約する', postback(slotData('ask', s))), flex: 2 },
    ],
  }));
  if (slots.length > shown.length) rows.push(text(`ほか ${slots.length - shown.length} 件`, { size: 'xs', color: GRAY }) as any);
  return flex(`${title}\n${slots.map(formatSlot).join('\n')}`, bubble(title, rows));
}

/** 「予約する」を押したときの確認 */
export function confirmMessage(slot: Slot, people: number, dryRun: boolean): Message {
  return flex(
    `${formatSlot(slot)} を予約しますか？`,
    bubble(
      'この枠を予約しますか？',
      [
        text(formatSlot(slot), { size: 'md', weight: 'bold' }),
        text(`${config.sport}・${people}人`, { size: 'sm', color: GRAY }),
        ...(dryRun ? [text('🧪 お試しモード中なので、最後の「申込」は押しません', { size: 'xs', color: GRAY })] : []),
      ],
      [
        button('予約する', postback(slotData('book', slot), '予約する')),
        button('やめる', postback('cancel', 'やめる'), false),
      ],
    ),
  );
}

export interface SettingsView {
  paused: boolean;
  autoEnabled: boolean;
  dryRun: boolean;
  loginProblem: boolean;
}

/** 設定。各行のボタンで切り替える */
export function settingsMessage(v: SettingsView): Message {
  const row = (label: string, value: string, next: string, data: string) => ({
    type: 'box',
    layout: 'horizontal',
    alignItems: 'center',
    spacing: 'sm',
    contents: [
      text(label, { size: 'sm', flex: 3 }),
      text(value, { size: 'sm', weight: 'bold', flex: 3 }),
      { ...button(next, postback(data, next), false), flex: 3 },
    ],
  });
  return flex(
    '設定',
    bubble('⚙️ 設定', [
      row('空き確認', v.paused ? '⏸ 停止中' : '▶️ 動作中', v.paused ? '再開する' : '止める', 'toggle|paused'),
      row('自動予約', v.autoEnabled ? '🤖 オン' : 'オフ', v.autoEnabled ? 'オフにする' : 'オンにする', 'toggle|auto'),
      row('予約モード', v.dryRun ? '🧪 お試し' : '✅ 本番', v.dryRun ? '本番にする' : 'お試しにする', 'toggle|dryRun'),
      text(
        v.dryRun
          ? 'お試しモードでは申込の直前まで進めて止めます。うまく動くのを確かめたら本番にしてください'
          : '本番モードでは実際に予約します',
        { size: 'xs', color: GRAY },
      ),
      ...(v.loginProblem ? [text('🔑 予約システムにログインできていません。PC で npm run set-credentials をしてください', { size: 'xs', color: '#D93025' })] : []),
    ]),
  );
}

/** 条件（いつの枠を探すか・人数） */
export function conditionsMessage(presets: { id: string; label: string }[], current: string, people: number): Message {
  const choice = (label: string, selected: boolean, data: string) => ({
    ...button(selected ? `✓ ${label}` : label, postback(data, label), selected),
    flex: 1,
  });
  const grid = <T,>(items: T[], perRow: number, f: (x: T) => unknown) =>
    Array.from({ length: Math.ceil(items.length / perRow) }, (_, i) => ({
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      contents: items.slice(i * perRow, i * perRow + perRow).map(f),
    }));
  return flex(
    '条件',
    bubble('📅 探す条件', [
      text('いつの枠を探すか', { size: 'sm', color: GRAY }),
      ...grid(presets, 2, (p) => choice(p.label, p.id === current, `preset|${p.id}`)),
      text('人数', { size: 'sm', color: GRAY }),
      ...grid([2, 3, 4, 5, 6], 5, (n) => choice(`${n}`, n === people, `people|${n}`)),
      text(`施設: ${config.facilities.map((f) => f.replace('（個人利用）', '')).join('・')}`, { size: 'xs', color: GRAY }),
    ]),
  );
}

/** 予約一覧（このシステムで予約したもの） */
export function bookedMessage(slots: Slot[]): Message {
  const body = slots.length
    ? slots.map((s) => text(`・${formatSlot(s)}`, { size: 'sm' }))
    : [text('このシステムで予約した、これからの予約はありません', { size: 'sm' })];
  return flex(
    '予約一覧',
    bubble(
      '📋 予約一覧',
      [...body, text('取消は予約システムの「予約内容の確認・取消」からできます（前日19時まで。当日キャンセルは翌月1か月予約停止）', { size: 'xs', color: GRAY })],
      [button('予約システムを開く', { type: 'uri', uri: `${BASE}/Home` }, false)],
    ),
  );
}

export const HELP = `🏟️ 体育館予約システム
${config.sport}の空きを10分ごとに確認して、新しい空きが出たらお知らせします。

画面下のメニュー
・空き状況 … いま空いている枠と状態
・今すぐ確認 … その場で空きを調べ直す
・予約一覧 … このシステムで取った予約
・条件 … 探す曜日・時間帯と人数
・設定 … 止める／自動予約／お試し・本番
・ヘルプ … この説明

空き通知の「予約する」を押すと、確認のあとに予約します。`;

export function verifySignature(rawBody: string, signature: string | undefined) {
  if (!env.lineSecret || !signature) return false;
  const expected = createHmac('sha256', env.lineSecret).update(rawBody).digest();
  const given = Buffer.from(signature, 'base64');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
