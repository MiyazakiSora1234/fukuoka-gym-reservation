// 状態とログイン情報の保存先。STATE_BUCKET があれば S3、なければ .data/ のファイル
import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { S3Client, GetObjectCommand, PutObjectCommand, NoSuchKey } from '@aws-sdk/client-s3';
import type { Slot } from './site.ts';

const bucket = process.env.STATE_BUCKET;
const s3 = bucket ? new S3Client({}) : undefined;

export async function loadJSON<T>(key: string, fallback: T): Promise<T> {
  if (s3) {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return { ...fallback, ...JSON.parse(await res.Body!.transformToString()) };
    } catch (e) {
      if (e instanceof NoSuchKey) return fallback;
      throw e;
    }
  }
  const path = `.data/${key}`;
  return existsSync(path) ? { ...fallback, ...JSON.parse(readFileSync(path, 'utf8')) } : fallback;
}

export async function saveJSON(key: string, value: unknown) {
  const body = JSON.stringify(value, null, 2);
  if (s3) {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'application/json' }));
    return;
  }
  mkdirSync('.data', { recursive: true });
  writeFileSync(`.data/${key}`, body);
}

export interface State {
  /** 通知済みの枠。空きが埋まったら消して、また空いたら再通知する */
  notified: string[];
  /** 最後に確認したときの希望に合う空き */
  vacant: Slot[];
  lastCheckedAt?: string;
  /** 予約した枠（お試しモードの分は含めない） */
  booked: Slot[];
  /** 自動予約のお試しモードで処理済みの枠。同じ枠を何度も試さない */
  dryRuns: string[];
  /** ログイン切れを通知済みか。npm run login で戻す */
  loginNotified: boolean;
  /** LINE の「止めて」で true */
  paused: boolean;
  /** LINE から変えた自動予約の設定（config.json より優先） */
  autoBook?: { enabled?: boolean; dryRun?: boolean };
}

export const emptyState: State = {
  notified: [],
  vacant: [],
  booked: [],
  dryRuns: [],
  loginNotified: false,
  paused: false,
};

export const loadState = () => loadJSON<State>('state.json', emptyState);
export const saveState = (s: State) => saveJSON('state.json', s);
