// LINE のトーク画面の下に出るメニュー（リッチメニュー）を作り直す
//   npm run richmenu           … assets/richmenu.png で登録する（GitHub Actions から実行される）
//   npm run richmenu -- --render … 画像を描き直して assets/richmenu.png に保存する（開発時。Playwright が必要）
// ボタンは src/line.ts の MENU と同じテキストを送る。LINE のトークンは SSM から読む
import { readFileSync, writeFileSync } from 'node:fs';
import { MENU } from '../src/line.ts';
import { config } from '../src/config.ts';
import { lineSecrets } from '../src/secrets.ts';

const IMAGE = 'assets/richmenu.png';
const NAME = 'fukuoka-gym-reservation';
const W = 2500;
const H = 843;
const COLS = 3;
const ROWS = 2;

const ICONS: Record<(typeof MENU)[number], [string, string]> = {
  空き状況: [config.sport === 'バドミントン' ? '🏸' : '🏟️', 'いま空いている枠'],
  今すぐ確認: ['🔍', 'その場で調べ直す'],
  予約一覧: ['📋', '取った予約'],
  条件: ['📅', '曜日・時間・人数'],
  設定: ['⚙️', '停止・自動予約'],
  ヘルプ: ['❓', '使い方'],
};

async function api(path: string, init: RequestInit = {}, host = 'api.line.me') {
  const { token } = await lineSecrets();
  if (!token) throw new Error('LINE のチャネルアクセストークンが SSM に登録されていません');
  const res = await fetch(`https://${host}/v2/bot/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function renderImage(): Promise<Buffer> {
  const cells = MENU.map(
    (label) => `<div class="cell"><div class="icon">${ICONS[label][0]}</div><div class="label">${label}</div><div class="sub">${ICONS[label][1]}</div></div>`,
  ).join('');
  const html = `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; width: ${W}px; height: ${H}px; font-family: 'Yu Gothic UI', 'Meiryo', sans-serif; background: #f4f6f5; }
    .grid { display: grid; grid-template-columns: repeat(${COLS}, 1fr); grid-template-rows: repeat(${ROWS}, 1fr); width: 100%; height: 100%; gap: 6px; background: #d9dedb; }
    .cell { background: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; }
    .cell:nth-child(-n+3) { background: #f0fbf4; }
    .icon { font-size: 150px; line-height: 1; }
    .label { font-size: 92px; font-weight: 700; color: #1d2b22; }
    .sub { font-size: 50px; color: #6b7a71; }
  </style><div class="grid">${cells}</div>`;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.setContent(html);
  const png = await page.screenshot({ type: 'png' });
  await browser.close();
  return png;
}

if (process.argv.includes('--render')) {
  writeFileSync(IMAGE, await renderImage());
  console.log(`${IMAGE} に保存しました`);
  process.exit(0);
}

// 以前このスクリプトで作ったメニューは消す
const { richmenus } = await api('richmenu/list');
for (const m of richmenus.filter((m: { name: string }) => m.name === NAME)) {
  await api(`richmenu/${m.richMenuId}`, { method: 'DELETE' });
}

const cw = Math.floor(W / COLS);
const ch = Math.floor(H / ROWS);
const { richMenuId } = await api('richmenu', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    size: { width: W, height: H },
    selected: true,
    name: NAME,
    chatBarText: 'メニュー',
    areas: MENU.map((label, i) => ({
      bounds: { x: (i % COLS) * cw, y: Math.floor(i / COLS) * ch, width: cw, height: ch },
      action: { type: 'message', label, text: label },
    })),
  }),
});
const png = readFileSync(IMAGE);
await api(`richmenu/${richMenuId}/content`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array(png) }, 'api-data.line.me');
await api(`user/all/richmenu/${richMenuId}`, { method: 'POST' });
console.log(`リッチメニューを設定しました（${richMenuId}）`);
