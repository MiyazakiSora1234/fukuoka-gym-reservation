// `aws login` のログイン情報を、AWS SDK や CDK が読める環境変数にする
// （aws login の認証情報は SDK から直接読めないため、一時的なキーを取り出して渡す）
import { execFileSync } from 'node:child_process';

export const REGION = 'ap-northeast-1';

export function useAwsLogin() {
  const creds = JSON.parse(
    execFileSync('aws', ['configure', 'export-credentials', '--format', 'process', '--region', REGION], {
      encoding: 'utf8',
    }),
  );
  Object.assign(process.env, {
    AWS_ACCESS_KEY_ID: creds.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.SecretAccessKey,
    AWS_SESSION_TOKEN: creds.SessionToken ?? '',
    AWS_REGION: REGION,
    AWS_DEFAULT_REGION: REGION,
  });
}
