# CDK Monitoring (CloudWatch)

3層Webアーキテクチャの CloudWatch 監視を AWS CDK (TypeScript) で構築する構成。
ベースのインフラと監視を別スタックに分離し、さらに CloudFront のアラームだけを
`us-east-1` に切り出している。あわせて、最小権限のセキュリティグループ・CloudFront
からのアクセス制限・転送中の暗号化など、セキュリティのハードニングも盛り込んでいる。

## ディレクトリ構成

```text
.
├── bin/
│   └── app.ts                          # ★ 3スタックを配線（cdk init の bin/<name>.ts をリネーム）
├── lib/
│   ├── base-infra-stack.ts             # ★ ベース3層: VPC / ALB / ASG+EC2 / RDS(MultiAZ) / S3 / CloudFront
│   ├── monitoring-stack.ts             # ★ 監視: EC2 / RDS / ALB / S3 アラーム + SNS + Dashboard
│   ├── cloudfront-monitoring-stack.ts  # ★ CloudFront 監視（us-east-1 / アラーム + SNS）
│   └── ssm-stack.ts                    # ★ SSM: VPCエンドポイント + セッションログ + CloudWatch Agent
├── cdk.json                            # ▲ app のパスを bin/app.ts に変更（他はほぼデフォルト）
├── package.json                        # ▲ scripts 調整・jest 系の依存を削除
├── tsconfig.json                       # デフォルト
├── .gitignore                          # デフォルト + secrets / cdk.context.json を除外
├── .gitleaks.toml                      # gitleaks 設定（シークレットスキャン）
├── .husky/pre-commit                   # コミット前のローカル gitleaks 実行
├── .github/
│   ├── dependabot.yml                  # 依存(npm)/Actions の脆弱性検知・更新
│   └── workflows/
│       ├── gitleaks.yml                # CI: シークレットスキャン
│       └── codeql.yml                  # CI: コード静的解析
├── SECURITY.md                         # リポジトリ公開時のセキュリティ対策
└── README.md                           # ★ この構成の説明
```

凡例: `★` = 新規／全面的に作成、`▲` = `cdk init` の生成物を一部変更、無印 = デフォルトのまま。
※ `cdk init` が生成する `test/` と `jest.config.js` はテスト未着手のため同梱していない。

## スタック構成

| スタック | リージョン | 役割 |
| --- | --- | --- |
| `BaseInfraStack` | ap-northeast-1 | VPC / ALB / ASG+EC2 / RDS(MultiAZ) / S3 / CloudFront（最小権限SG・CloudFront限定・カスタムヘッダー検証・任意HTTPS・RDS TLS強制） |
| `MonitoringStack` | ap-northeast-1 | EC2(CPU/メモリ/ディスク)・RDS・ALB・S3 のアラーム + SNS + ダッシュボード |
| `CloudFrontMonitoringStack` | us-east-1 | CloudFront のアラーム + SNS |
| `SsmStack` | ap-northeast-1 | インターフェース型VPCエンドポイント + セッションログ→CloudWatch Logs + CloudWatch Agent(mem/disk) |

## 設計上のポイント

- **CloudFront のメトリクスは us-east-1 に集約される。** CDK は「アラームはメトリクスと
  同一リージョンのスタックに置く」ことを要求するため、CloudFront のアラームだけは
  `us-east-1` スタックに分離している。
- **ダッシュボードはリージョンをまたげる。** そのため `MonitoringStack`（東京）の
  ダッシュボードに、`region: 'us-east-1'` を指定した CloudFront メトリクスのグラフも
  載せている。アラームとダッシュボードでこの違いがある点に注意。
- **SNS トピックもリージョンを越えられない。** 東京と us-east-1 でそれぞれ作成している。
- CloudFront の distributionId を東京→us-east-1 へ渡すために、両スタックで
  `crossRegionReferences: true` を有効化（裏で SSM Parameter Store を使う）。
- **EC2 のメモリ・ディスク使用率は既定メトリクスに含まれない。** `SsmStack` が
  CloudWatch Agent をインストール・設定し、`CWAgent` 名前空間で `mem_used_percent` /
  `disk used_percent` を取得する。エージェント設定は SSM Parameter Store に置き、
  SSM Association で ASG インスタンスへ配布する。
- **CloudWatch Agent の設定パラメータ名は `AmazonCloudWatch-` で始める。**
  `CloudWatchAgentServerPolicy` の `ssm:GetParameter` が `parameter/AmazonCloudWatch-*`
  に限定されているため、別名だとエージェントが設定を読み取れない。
- **インスタンスロールへの権限付与は `BaseInfraStack` 側。** SSM Core と
  CloudWatchAgentServerPolicy はインスタンスの基礎能力なのでベースで付与し、SSM の
  “機能”（エンドポイント・ログ出力・エージェント配布）は `SsmStack` に分離している。
- **インターフェース型エンドポイントで Session Manager / CloudWatch を VPC 内に閉じる。**
  S3 用はゲートウェイ型を併用（無料）。なおゲートウェイ型は CloudWatch メトリクスを持たない。

## セキュリティ設計

- **3層の最小権限セキュリティグループ。** ALB / EC2 / RDS に明示的な SG を割り当て、
  層間（ALB→EC2→RDS）の必要な通信のみ許可。`addTargets` / `allowDefaultPortFrom` が
  層間ルールを自動で張る。
- **ALB は CloudFront からのみ受信。** マネージドプレフィックスリスト
  `com.amazonaws.global.cloudfront.origin-facing` を `AwsCustomResource` で名前解決し、
  ALB の ingress をそのIP範囲に限定。
- **カスタムヘッダー検証で迂回を防止。** プレフィックスリストは全AWSアカウントの CloudFront
  が共有するIP範囲のため、IP制限だけでは他人の CloudFront から迂回されうる。CloudFront が
  付与する `X-Origin-Verify` ヘッダーを ALB のリスナールールで検証し、一致しないリクエストは
  403 で拒否する（ネットワーク層＋アプリ層の二重防御）。
- **秘密値はテンプレートに残さない。** ヘッダーの秘密値は Secrets Manager で生成し、
  `secretValue.unsafeUnwrap()` で参照する。テンプレートに埋まるのは実値ではなく
  `{{resolve:secretsmanager:...}}` の動的参照で、deploy 時に解決される。ソース・合成
  テンプレートのどちらにも平文は載らない（解決後の値は自アカウント内のリソースには存在する）。
- **転送中の暗号化。** User→CloudFront は HTTPS（`REDIRECT_TO_HTTPS`）。独自ドメイン指定時は
  CloudFront→ALB も HTTPS（ACM 証明書 + Route53 Alias）。EC2→RDS は RDS パラメータグループの
  `require_secure_transport=ON` で TLS を強制（実接続の TLS 化はアプリ側の責務）。
- **ドメイン情報をリポジトリに残さない。** ドメイン/ゾーンは環境変数で注入し、
  `HostedZone.fromHostedZoneAttributes`（`fromLookup` を使わない）で参照することで
  `cdk.context.json` への記録も回避。`.gitignore` でも同ファイルを除外。
- **S3 はセキュリティグループ非対応。** VPC 内リソースでないため SG の概念がなく、
  Block Public Access / バケットポリシー / OAC / TLS強制（`enforceSSL`）で保護する。
- 秘密管理の前提: RDS 認証情報は Secrets Manager 自動生成、アカウントIDは環境変数経由で
  ハードコードなし。

### リポジトリ公開時のセキュリティ（リポジトリ／サプライチェーン側）

AWS リソース側とは別に、GitHub 公開に向けた対策も導入している。詳細は [`SECURITY.md`](./SECURITY.md)。

- **gitleaks**: コミット前（`.husky/pre-commit`）と CI（`.github/workflows/gitleaks.yml`）で
  シークレット混入をスキャン。
- **Dependabot**（`.github/dependabot.yml`）: npm 依存と GitHub Actions の脆弱性検知・更新。
- **CodeQL**（`.github/workflows/codeql.yml`）: コードの静的解析。
- **運用**: まず Private で作成 → 確認後に Public、ブランチ保護、Secret scanning + Push
  protection の有効化など（チェックリストは `SECURITY.md`）。
- **cdk-nag**（IaC 静的チェック）: `bin/app.ts` に有効化用の雛形をコメントで用意。

## デプロイ手順

```bash
npm install

# 両リージョンの bootstrap が必須（CloudFront 用に us-east-1 も）
cdk bootstrap aws://<ACCOUNT_ID>/ap-northeast-1
cdk bootstrap aws://<ACCOUNT_ID>/us-east-1

# 通知先メールを渡してデプロイ（届いたメールで Subscribe を承認すること）
# --all で BaseInfraStack / MonitoringStack / CloudFrontMonitoringStack / SsmStack を全てデプロイ
# カスタムヘッダーの秘密値は Secrets Manager が自動生成するため、渡す必要はない。
cdk deploy --all -c alarmEmail=you@example.com
```

CloudFront→ALB も HTTPS 化する場合は、ドメイン情報を環境変数で渡す（リポジトリには残さない）:

```bash
APP_DOMAIN_NAME=app.example.com \
APP_HOSTED_ZONE_NAME=example.com \
APP_HOSTED_ZONE_ID=Z0123456789ABCDEFGHIJ \
cdk deploy --all -c alarmEmail=you@example.com
```

3つの環境変数が揃ったときだけ HTTPS モードになり、揃わなければ CloudFront→ALB は HTTP に
フォールバックする。

## 注意（学習用設定）

- RDS / S3 は `removalPolicy: DESTROY`。本番では `RETAIN` に変更すること。
- NAT Gateway を 1 つ使用（課金対象）。SSM のエンドポイントは Session Manager を
  プライベート化するが、`dnf install` 等の一般的なegressにはまだ NAT が必要。完全な
  NAT レス化にはパッケージ取得方法（カスタムAMI等）の見直しが要る。
- S3 の詳細リクエストメトリクスは有料のため無効のまま。
- **`SsmStack` の Session Manager 設定ドキュメント `SSM-SessionManagerRunShell` は
  アカウント/リージョンに1つだけの予約名。** 既に存在する環境では作成が衝突するため、
  その場合は当該リソースを外すか既存ドキュメントを削除してから deploy する。
- CloudWatch Agent はインストール→設定の SSM Association 適用後、数分かけて
  インスタンスに反映される。`CWAgent` 名前空間のメトリクスが出るまで少し待つ。
- **ALB を直接叩くと 403。** カスタムヘッダー検証を入れたため、CloudFront を経由しない
  直アクセスは拒否される。動作確認は CloudFront 経由で行う（直接確認したい場合は一時的に
  検証ルールを緩める）。
- **CloudFront→ALB の HTTPS には独自ドメインが必須。** ALB 既定DNS (`*.elb.amazonaws.com`)
  には公開証明書を発行できないため。環境変数3つを指定しない場合は HTTP にフォールバックする。
- **`{{resolve:secretsmanager:...}}` 動的参照の対応可否は deploy 時に最終確認。** CloudFront
  カスタムヘッダー / ALB リスナー条件での動的参照が万一弾かれた場合は、参照方法の見直しが必要。
