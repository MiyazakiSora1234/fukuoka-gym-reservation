// 予約システムの利用者ID・パスワードを AWS の SSM パラメータストア（SecureString）に登録する
// ログインが切れたとき、Lambda がこれを使って自動でログインし直す。パスワードを変えたらもう一度実行する
//   npm run set-credentials
import { createInterface } from 'node:readline';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import { useAwsLogin } from './aws-env.ts';

useAwsLogin();
const { USER_ID_PARAM, PASSWORD_PARAM } = await import('../src/credentials.ts');
const { loadState, saveState } = await import('../src/store.ts');

function ask(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    // 入力した文字を画面に出さない
    (rl as any)._writeToOutput = (s: string) => {
      if (s.includes(question)) process.stdout.write(question);
    };
  }
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    }),
  );
}

const userId = await ask('利用者ID: ');
if (!/^[a-zA-Z0-9-]+$/.test(userId)) {
  console.error('利用者IDは半角英数字とハイフンです（メールアドレスではありません）');
  process.exit(1);
}
const password = await ask('パスワード（表示されません）: ', true);
if (!password) process.exit(1);

const ssm = new SSMClient({});
for (const [Name, Value] of [
  [USER_ID_PARAM, userId],
  [PASSWORD_PARAM, password],
]) {
  await ssm.send(new PutParameterCommand({ Name, Value, Type: 'SecureString', Overwrite: true }));
}
// ログイン切れで止まっていた自動予約を再開させる
if (process.env.STATE_BUCKET) await saveState({ ...(await loadState()), loginNotified: false });
console.log('登録しました。次に予約するとき、ログインが切れていれば自動でログインします');
