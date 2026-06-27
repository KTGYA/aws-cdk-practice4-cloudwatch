#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { BaseInfraStack } from '../lib/base-infra-stack';
import { MonitoringStack } from '../lib/monitoring-stack';
import { CloudFrontMonitoringStack } from '../lib/cloudfront-monitoring-stack';
import { SsmStack } from '../lib/ssm-stack';

const app = new cdk.App();

// --- セキュリティ静的チェック (cdk-nag) ---
// 有効化すると、合成(synth)時に AWS のセキュリティ・ベストプラクティス違反を検出する。
// 既に devDependencies に導入済み。下の3行のコメントを外せば有効化される。
// 多数の指摘が出るため、確認しながら修正 or NagSuppressions で個別抑制する運用。
// import { Aspects } from 'aws-cdk-lib';
// import { AwsSolutionsChecks } from 'cdk-nag';
// Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// アカウントは `cdk deploy` 実行時のクレデンシャルから自動解決される
const account = process.env.CDK_DEFAULT_ACCOUNT;
const primaryRegion = 'ap-northeast-1'; // 東京: ベース構成と大半の監視

// ★ 今回変更: 通知先メールも context ではなく環境変数から読む。
//   ドメイン情報と同じ扱いにして、ソース・context・テンプレート差分のいずれにも実値を残さない。
//   設定例（PowerShell）:
//     $env:APP_ALARM_EMAIL = "you@example.com"
//     npx cdk deploy --all
//   未設定の場合はダミーの 'you@example.com' にフォールバックする（通知は届かない）。
const alarmEmail = process.env.APP_ALARM_EMAIL ?? 'you@example.com';

// ★ 機密性のある値は context ではなく環境変数から読む。
//   context は cdk.context.json / cdk.json 経由でリポジトリに残りうるため。
//   ・カスタムヘッダーの秘密値は廃止（ベーススタック内の Secrets Manager が生成）。
//   ・ドメイン情報は環境変数で注入し、ソースにもテンプレート差分にも残さない。
//   例: APP_DOMAIN_NAME=app.example.com APP_HOSTED_ZONE_NAME=example.com \
//       APP_HOSTED_ZONE_ID=Z0123456789ABCDEFGHIJ cdk deploy --all
const domainName = process.env.APP_DOMAIN_NAME;
const hostedZoneName = process.env.APP_HOSTED_ZONE_NAME;
const hostedZoneId = process.env.APP_HOSTED_ZONE_ID;

// 1) ベースの3層アーキテクチャ（VPC / ALB / ASG+EC2 / RDS MultiAZ / S3 / CloudFront）
const base = new BaseInfraStack(app, 'BaseInfraStack', {
  env: { account, region: primaryRegion },
  // CloudFront(東京スタックで生成)のIDを us-east-1 スタックへ渡すために必須
  crossRegionReferences: true,
  domainName, // 環境変数由来（任意）
  hostedZoneName, // 環境変数由来（任意）
  hostedZoneId, // fromLookup 回避のため ID も明示（任意）
});

// 2) CloudWatch 監視（東京）: EC2 / RDS / ALB / S3 のアラーム + SNS + ダッシュボード
//    ダッシュボードは“リージョンをまたげる”ので CloudFront のグラフもここに載せる
const monitoring = new MonitoringStack(app, 'MonitoringStack', {
  env: { account, region: primaryRegion },
  crossRegionReferences: true,
  alarmEmail,
  alb: base.alb,
  targetGroup: base.targetGroup,
  asg: base.asg,
  db: base.db,
  bucket: base.bucket,
  distribution: base.distribution,
});
monitoring.addDependency(base);

// 3) CloudFront 監視（us-east-1）: アラームは“リージョンをまたげない”ため別スタックに分離
const cfMonitoring = new CloudFrontMonitoringStack(app, 'CloudFrontMonitoringStack', {
  env: { account, region: 'us-east-1' },
  crossRegionReferences: true,
  alarmEmail,
  // 東京スタックの distributionId を渡す → 裏で SSM Parameter Store 経由で共有される
  distributionId: base.distribution.distributionId,
});
cfMonitoring.addDependency(base);

// 4) SSM（東京）: Session Manager のプライベート接続 + セッションログ + CloudWatch Agent 配布
const ssm = new SsmStack(app, 'SsmStack', {
  env: { account, region: primaryRegion },
  vpc: base.vpc,
  asg: base.asg,
});
ssm.addDependency(base);
