// AWS の構成（CDK）。npm run deploy で作成・更新する
//   S3      … state.json / auth.json（ログインのクッキー）/ health.json
//   worker  … 空き確認と予約（ヘッドレス Chromium）。EventBridge で定期実行
//   webhook … LINE の Webhook を受ける関数URL
// 常時起動のサーバーを置かず、Lambda の無料枠に収まる構成にしている
import 'dotenv/config';
import { App, Stack, Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Bucket, BlockPublicAccess, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Runtime, Architecture, FunctionUrlAuthType } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import config from '../config.json' with { type: 'json' };

const app = new App();
const stack = new Stack(app, 'FukuokaGymReservation', { env: { region: 'ap-northeast-1' } });

const bucket = new Bucket(stack, 'State', {
  blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
  encryption: BucketEncryption.S3_MANAGED,
  enforceSSL: true,
  removalPolicy: RemovalPolicy.RETAIN,
});

const environment = {
  STATE_BUCKET: bucket.bucketName,
  LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '',
  LINE_CHANNEL_SECRET: process.env.LINE_CHANNEL_SECRET ?? '',
  LINE_USER_ID: process.env.LINE_USER_ID ?? '',
  TZ: 'Asia/Tokyo',
};

const common = {
  entry: 'src/lambda.ts',
  runtime: Runtime.NODEJS_22_X,
  architecture: Architecture.X86_64,
  bundling: {
    format: OutputFormat.ESM,
    target: 'node22',
    // ESM の出力で require を使う依存があるため
    banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    // ブラウザ本体はバンドルせず node_modules ごと入れる。PC 用の playwright は使わない
    nodeModules: ['@sparticuz/chromium', 'playwright-core'],
    externalModules: ['playwright', '@aws-sdk/*'],
  },
};

const worker = new NodejsFunction(stack, 'Worker', {
  ...common,
  handler: 'worker',
  memorySize: 2048,
  timeout: Duration.minutes(5),
  environment,
  logGroup: new LogGroup(stack, 'WorkerLogs', { retention: RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY }),
  // 失敗した非同期呼び出しを再試行すると二重予約になりうるので再試行しない
  retryAttempts: 0,
});
bucket.grantReadWrite(worker);
// 予約システムの利用者ID・パスワード（npm run set-credentials で登録する SecureString）を読む
worker.addToRolePolicy(
  new PolicyStatement({
    actions: ['ssm:GetParameters'],
    resources: [stack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: 'fukuoka-gym-reservation/*' })],
  }),
);
worker.addToRolePolicy(
  new PolicyStatement({
    actions: ['kms:Decrypt'],
    resources: ['*'],
    conditions: { StringEquals: { 'kms:ViaService': `ssm.${stack.region}.amazonaws.com` } },
  }),
);

const webhook = new NodejsFunction(stack, 'Webhook', {
  ...common,
  handler: 'webhook',
  memorySize: 256,
  timeout: Duration.seconds(15),
  environment: { ...environment, WORKER_FUNCTION: worker.functionName },
  logGroup: new LogGroup(stack, 'WebhookLogs', { retention: RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY }),
});
bucket.grantReadWrite(webhook);
worker.grantInvoke(webhook);
const url = webhook.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });

// 確認しない時間帯（quietHours, JST）を除いて intervalMinutes ごとに実行する。cron は UTC
const [quietFrom, quietTo] = config.quietHours;
const activeUtcHours = Array.from({ length: 24 }, (_, h) => h)
  .filter((h) => !(h >= quietFrom && h < quietTo))
  .map((h) => (h + 15) % 24)
  .sort((a, b) => a - b);
new Rule(stack, 'Schedule', {
  schedule: Schedule.cron({ minute: `0/${config.intervalMinutes}`, hour: activeUtcHours.join(',') }),
  targets: [new LambdaFunction(worker, { retryAttempts: 0 })],
});

new CfnOutput(stack, 'WebhookUrl', { value: url.url });
new CfnOutput(stack, 'StateBucket', { value: bucket.bucketName });
