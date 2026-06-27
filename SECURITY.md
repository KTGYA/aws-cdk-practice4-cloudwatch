# セキュリティ対策

GitHub への公開にあたって導入した、リポジトリ／サプライチェーン側のセキュリティ対策。
（AWS リソース側のハードニング ― 最小権限 SG・HTTPS・Secrets Manager 等 ― は README の
「セキュリティ設計」を参照）

> 注: 一部は生成AIとの壁打ちで整理した内容を含みます。導入前に各ツールの公式ドキュメントで
> 最新の使い方を確認してください。

## 導入済み（このリポジトリのファイル）

| 対策 | 目的 | 該当ファイル |
| --- | --- | --- |
| `.gitignore` | 秘密情報・生成物をコミットしない | `.gitignore` |
| gitleaks（ローカル） | コミット前にステージ差分をシークレットスキャン | `.husky/pre-commit`, `.gitleaks.toml` |
| gitleaks（CI） | push/PR 時に履歴全体をシークレットスキャン | `.github/workflows/gitleaks.yml` |
| Dependabot | 依存（npm）と GitHub Actions の脆弱性検知・更新 | `.github/dependabot.yml` |
| CodeQL | コードの静的解析（脆弱性検出） | `.github/workflows/codeql.yml` |

### セットアップ

```bash
# husky（pre-commit フック）を有効化
npm install --save-dev husky
npm run prepare        # package.json の "prepare": "husky" が .husky を有効化

# gitleaks をローカルにインストール（例: macOS）
brew install gitleaks
```

## 公開前のチェックリスト（運用・GitHub設定）

ファイルだけでなく、リポジトリの設定・運用も重要。

- [ ] **まず Private リポジトリで作成**し、問題ないと確認できてから Public に切り替える。
- [ ] GitHub の **Secret scanning + Push protection** を有効化（公開リポジトリは無料。
      シークレットを含む push をブロックしてくれる）。
- [ ] **Dependabot alerts / security updates** をリポジトリ設定で有効化。
- [ ] `main` ブランチに **ブランチ保護ルール**（PR必須・CIパス必須・直push禁止）を設定。
- [ ] コミット履歴に過去のシークレットが残っていないか確認（`gitleaks git . ` で全履歴スキャン）。
- [ ] **AWS アカウントID・ドメイン名・ARN** などが README やコードに残っていないか確認
      （本構成では環境変数・Secrets Manager 経由にして残さない設計）。

## 追加で考慮すべき点（CDK / IaC 固有）

### cdk-nag によるIaCセキュリティ静的チェック（推奨）

CDK には、合成時に AWS のセキュリティベストプラクティス違反を検出する **cdk-nag** がある。
「暗号化されていない」「過剰な権限」「ログ未設定」などを synth 時に指摘してくれる、IaC 版の
リンター。導入は `bin/app.ts` 参照（コメントで雛形を用意済み）。

```ts
import { Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
```

有効化すると多数の指摘が出るため、内容を確認しながら修正、または正当な理由があるものは
`NagSuppressions` で個別に抑制する運用になる。

### デプロイ用クレデンシャルは OIDC を使う

もし GitHub Actions から `cdk deploy` を自動化する場合、**長期の AWS アクセスキーを
リポジトリ Secrets に保存しない**こと。代わりに **GitHub OIDC + IAM ロール**を使い、
一時クレデンシャルでデプロイする。キーの漏洩・失効管理のリスクをなくせる。

### その他

- `cdk.context.json` は `.gitignore` 済み（アカウントID・ゾーン情報の流出防止）。
- `npm audit` を定期実行（Dependabot と併用して依存の脆弱性を早期に把握）。
- GitHub Actions は信頼できる action のみ使用し、Dependabot（github-actions）で最新に保つ。
