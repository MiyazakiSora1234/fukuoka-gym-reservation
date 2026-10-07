import json from '../config.json' with { type: 'json' };

export interface Want {
  /** 曜日（日月火水木金土）。省略するとすべての曜日 */
  weekdays?: string[];
  /** この時刻以降に始まる枠（HH:MM） */
  from?: string;
  /** この時刻までに終わる枠（HH:MM） */
  to?: string;
}

export interface Config {
  /** LINE の「条件」で選べる施設。予約システムの施設選択画面の名前そのまま。順番を変えると古いボタンが別の施設を指すので、足すときは末尾に */
  facilities: string[];
  /** 最初に選ばれている施設 */
  defaultFacilities: string[];
  /** 種目。時間帯別空き状況で、行の名前にこの文字列を含む枠を探す（例: バドミントン、卓球） */
  sport: string;
  /** 施設別空き状況で見る行（バドミントンは「競技場」、卓球は「小体育室」など） */
  dayRow: string;
  weeksAhead: number;
  wants: Want[];
  intervalMinutes: number;
  /** この時間帯（時）は確認しない。[開始, 終了) */
  quietHours: [number, number];
  autoBook: {
    enabled: boolean;
    /** true の間は申込内容入力まで進んで、最後の「申込」は押さずに止まる */
    dryRun: boolean;
    /** 利用月ごとの自動予約の上限 */
    maxPerMonth: number;
    /** 今日から何日以上先の枠だけ予約するか（1 = 明日以降） */
    minDaysAhead: number;
    /** 申込内容入力の「利用目的」で選ぶ項目。省略すると sport と同じ */
    purpose?: string;
    /** 利用人数（例: バドミントン個人利用は2〜6名） */
    people: number;
  };
}

// Lambda にも同梱されるよう import で読む
export const config: Config = json as Config;

const WEEKDAYS = '日月火水木金土';

export function weekdayOf(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export function matchesWant(s: { date: string; from: string; to: string }, wants: Want[]) {
  const wd = weekdayOf(s.date);
  return wants.some(
    (w) =>
      (!w.weekdays || w.weekdays.includes(wd)) &&
      (!w.from || s.from >= w.from) &&
      (!w.to || s.to <= w.to),
  );
}
