// `aws login` のログイン情報を CDK に渡して実行する: node scripts/aws.ts deploy
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useAwsLogin } from './aws-env.ts';

useAwsLogin();
// cdk.out を OneDrive などの同期フォルダに置くと、ビルド中のフォルダ名の変更が EPERM で失敗するので一時フォルダに出す
const output = join(tmpdir(), 'fukuoka-gym-reservation-cdk.out');
const r = spawnSync('npx', ['cdk', ...process.argv.slice(2), '--output', JSON.stringify(output)], { stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
