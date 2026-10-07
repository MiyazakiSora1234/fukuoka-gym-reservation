// 予約システムの利用者ID・パスワード。AWS の SSM パラメータストア（SecureString、無料）に置く
// 登録は npm run set-credentials。読めるのは worker Lambda だけ
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';

export const PARAM_PREFIX = '/fukuoka-gym-reservation/';
export const USER_ID_PARAM = `${PARAM_PREFIX}user-id`;
export const PASSWORD_PARAM = `${PARAM_PREFIX}password`;

export interface Credentials {
  userId: string;
  password: string;
}

let cached: Credentials | null | undefined;

/** 登録されていなければ null（その場合は npm run login で保存したクッキーだけで動く） */
export async function loadCredentials(): Promise<Credentials | null> {
  if (cached !== undefined) return cached;
  if (!process.env.STATE_BUCKET) return (cached = null);
  const res = await new SSMClient({}).send(
    new GetParametersCommand({ Names: [USER_ID_PARAM, PASSWORD_PARAM], WithDecryption: true }),
  );
  const get = (name: string) => res.Parameters?.find((p) => p.Name === name)?.Value;
  const userId = get(USER_ID_PARAM);
  const password = get(PASSWORD_PARAM);
  return (cached = userId && password ? { userId, password } : null);
}
