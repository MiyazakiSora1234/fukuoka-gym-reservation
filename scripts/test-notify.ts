// LINE に届くか確かめる: npm run test-notify
import { notify } from '../src/notify.ts';

await notify('🏸 テスト通知です。これが届いていれば設定は完了です。');
