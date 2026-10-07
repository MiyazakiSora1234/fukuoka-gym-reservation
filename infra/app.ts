// AWS の構成（CDK）。GitHub の main に push すると GitHub Actions がデプロイする
//   S3      … state.json / auth.json（ログインのクッキー）/ health.json / credentials-link.json
//   SSM     … LINE のトークン・シークレット、予約システムの利用者ID・パスワード（SecureString。値はスタックの外で登録）
//   worker  … 空き確認と予約（ヘッドレス Chromium）。EventBridge で定期実行
//   webhook … 関数URL。LINE の Webhook と、ログイン情報の入力ページ
//   GitHub  … GitHub Actions が鍵なし（OIDC）でデプロイするためのロール
// 常時起動のサーバーを置かず、Lambda の無料枠に収まる構成にしている
import { App, Stack, Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { PolicyStatement, Role, OpenIdConnectProvider, WebIdentityPrincipal } from 'aws-cdk-lib/aws-iam';
import { Bucket, BlockPublicAccess, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Runtime, Architecture, FunctionUrlAuthType } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import config from '../config.json' with { type: 'json' };

const GITHUB_REPO = 'MiyazakiSora1234/fukuoka-gym-reservation';

const app = new App();
const stack = new Stack(app, 'FukuokaGymReservation', { env: { region: 'ap-northeast-1' } });

const bucket = new Bucket(stack, 'State', {
  blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
  encryption: BucketEncryption.S3_MANAGED,
  enforceSSL: true,
  removalPolicy: RemovalPolicy.RETAIN,
});

const paramArn = (name: string) =>
  stack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `fukuoka-gym-reservation/${name}` });
// SecureString は AWS 管理キー（aws/ssm）で暗号化される。SSM 経由の場合だけ使えるようにする
const kmsViaSsm = (actions: string[]) =>
  new PolicyStatement({
    actions,
    resources: ['*'],
    conditions: { StringEquals: { 'kms:ViaService': `ssm.${stack.region}.amazonaws.com` } },
  });

const environment = { STATE_BUCKET: bucket.bucketName, TZ: 'Asia/Tokyo' };

const common = {
  entry: 'src/lambda.ts',
  runtime: Runtime.NODEJS_22_X,
  architecture: Architecture.X86_64,
  bundling: {
    format: OutputFormat.ESM,
    target: 'node22',
    // ESM の出力で require を使う依存があるため
    banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    // ブラウザ本体はバンドルせず node_modules ごと入れる。開発用の playwright は使わない
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
worker.addToRolePolicy(new PolicyStatement({ actions: ['ssm:GetParameters'], resources: [paramArn('*')] }));
worker.addToRolePolicy(kmsViaSsm(['kms:Decrypt']));

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
// LINE のトークン・シークレットを読み、入力ページから利用者ID・パスワードを書き込む
webhook.addToRolePolicy(
  new PolicyStatement({
    actions: ['ssm:GetParameters'],
    resources: [paramArn('line-channel-access-token'), paramArn('line-channel-secret')],
  }),
);
webhook.addToRolePolicy(
  new PolicyStatement({ actions: ['ssm:PutParameter'], resources: [paramArn('user-id'), paramArn('password')] }),
);
webhook.addToRolePolicy(kmsViaSsm(['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey']));
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

// GitHub Actions（このリポジトリの main だけ）が鍵なしでデプロイできるようにする。
// 権限は CDK の bootstrap ロールを引き受けることと、リッチメニュー用に LINE のトークンを読むことだけ
const github = new OpenIdConnectProvider(stack, 'GitHubOidc', {
  url: 'https://token.actions.githubusercontent.com',
  clientIds: ['sts.amazonaws.com'],
});
const deployRole = new Role(stack, 'GitHubDeployRole', {
  roleName: 'fukuoka-gym-reservation-github-deploy',
  assumedBy: new WebIdentityPrincipal(github.openIdConnectProviderArn, {
    StringEquals: {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub': `repo:${GITHUB_REPO}:ref:refs/heads/main`,
    },
  }),
  maxSessionDuration: Duration.hours(1),
});
deployRole.addToPolicy(
  new PolicyStatement({
    actions: ['sts:AssumeRole'],
    resources: [`arn:aws:iam::${stack.account}:role/cdk-hnb659fds-*-${stack.account}-${stack.region}`],
  }),
);
deployRole.addToPolicy(new PolicyStatement({ actions: ['ssm:GetParameters'], resources: [paramArn('line-channel-access-token')] }));
deployRole.addToPolicy(kmsViaSsm(['kms:Decrypt']));

new CfnOutput(stack, 'WebhookUrl', { value: url.url });
new CfnOutput(stack, 'StateBucket', { value: bucket.bucketName });
new CfnOutput(stack, 'GitHubDeployRoleArn', { value: deployRole.roleArn });
