// PC で定期的に空きを確認する（クラウドに置かない場合）
//   node src/watch.ts         … ずっと動かし続ける
//   node src/watch.ts --once  … 1回だけ確認して終わる
import { config } from './config.ts';
import { runCheck } from './app.ts';
import { notify } from './notify.ts';

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
      await runCheck();
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
