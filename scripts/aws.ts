// `aws login` のログイン情報を CDK に渡して実行する: node scripts/aws.ts deploy
import { spawnSync } from 'node:child_process';
import { useAwsLogin } from './aws-env.ts';

useAwsLogin();
const r = spawnSync('npx', ['cdk', ...process.argv.slice(2)], { stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
