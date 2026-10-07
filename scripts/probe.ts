// site.ts の動作確認用。数週間先までの日別状況と、競技場に空きのある日の時間帯別状況を表示する
import { chromium } from 'playwright';
import { openDays, showWeek, readDays, openTimes, readTimes } from '../src/site.ts';

const facilities = ['市民体育館（個人利用）', '東体育館（個人利用）', '博多体育館（個人利用）'];
const browser = await chromium.launch();
const page = await browser.newPage();
await openDays(page, facilities);
const today = new Date();
for (let w = 0; w < 8; w++) {
  const d = new Date(today.getTime() + w * 7 * 864e5).toISOString().slice(0, 10);
  await showWeek(page, d);
  const cells = (await readDays(page)).filter((c) => c.room === '競技場');
  console.log(`== ${d}`, cells.map((c) => `${c.facility.slice(0, 2)}${c.date.slice(5)}:${c.status}`).join(' '));
  const open = cells.filter((c) => c.status === 'some' || c.status === 'vacant');
  if (open.length) {
    await openTimes(page, open.slice(0, 3));
    const times = await readTimes(page);
    for (const t of times.filter((t) => /バドミントン/.test(t.room))) console.log(t.facility, t.room, t.date, t.from, t.to, t.status);
    break;
  }
}
await browser.close();
