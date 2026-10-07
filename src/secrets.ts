// 秘密情報は AWS の SSM パラメータストア（SecureString、無料）に置き、Lambda が実行時に読む
//   line-channel-access-token / line-channel-secret … LINE Messaging API（最初に1回だけ登録する）
//   user-id / password … 予約システムの利用者ID・パスワード（LINE の「設定」から開く入力ページで登録する）
import { SSMClient, GetParametersCommand, PutParameterCommand } from '@aws-sdk/client-ssm';

export const PARAM_PREFIX = '/fukuoka-gym-reservation/';
export const PARAMS = {
  lineToken: `${PARAM_PREFIX}line-channel-access-token`,
  lineSecret: `${PARAM_PREFIX}line-channel-secret`,
  userId: `${PARAM_PREFIX}user-id`,
  password: `${PARAM_PREFIX}password`,
};

const ssm = new SSMClient({});

async function get(names: string[]): Promise<Record<string, string | undefined>> {
  const res = await ssm.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
  return Object.fromEntries(names.map((n) => [n, res.Parameters?.find((p) => p.Name === n)?.Value]));
}

let line: Promise<{ token: string; secret: string }> | undefined;

/** LINE のトークンとシークレット。環境変数があればそちら（テスト用） */
export function lineSecrets() {
  line ??= (async () => {
    if (process.env.LINE_CHANNEL_ACCESS_TOKEN) {
      return { token: process.env.LINE_CHANNEL_ACCESS_TOKEN, secret: process.env.LINE_CHANNEL_SECRET ?? '' };
    }
    const v = await get([PARAMS.lineToken, PARAMS.lineSecret]);
    return { token: v[PARAMS.lineToken] ?? '', secret: v[PARAMS.lineSecret] ?? '' };
  })();
  return line;
}

export interface Credentials {
  userId: string;
  password: string;
}

/** 予約システムの利用者ID・パスワード。登録されていなければ null。変更されることがあるので毎回読む */
export async function loadCredentials(): Promise<Credentials | null> {
  const v = await get([PARAMS.userId, PARAMS.password]);
  const userId = v[PARAMS.userId];
  const password = v[PARAMS.password];
  return userId && password ? { userId, password } : null;
}

export async function saveCredentials({ userId, password }: Credentials) {
  for (const [Name, Value] of [
    [PARAMS.userId, userId],
    [PARAMS.password, password],
  ]) {
    await ssm.send(new PutParameterCommand({ Name, Value, Type: 'SecureString', Overwrite: true }));
  }
}
