// `aws login` のログイン情報を CDK に渡して実行する: node scripts/aws.ts deploy
// CDK は aws login の認証情報を直接読めないので、一時的なキーを取り出して環境変数で渡す
import { execFileSync, spawnSync } from 'node:child_process';

const region = 'ap-northeast-1';
const creds = JSON.parse(execFileSync('aws', ['configure', 'export-credentials', '--format', 'process'], { encoding: 'utf8' }));
const env = {
  ...process.env,
  AWS_ACCESS_KEY_ID: creds.AccessKeyId,
  AWS_SECRET_ACCESS_KEY: creds.SecretAccessKey,
  AWS_SESSION_TOKEN: creds.SessionToken ?? '',
  AWS_REGION: region,
  AWS_DEFAULT_REGION: region,
};
const r = spawnSync('npx', ['cdk', ...process.argv.slice(2)], { env, stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
