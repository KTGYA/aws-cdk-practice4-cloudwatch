import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'; // ★ 今回追加

export interface BaseInfraStackProps extends cdk.StackProps {
  // ★ 今回変更: originSecret は廃止。秘密値はスタック内の Secrets Manager が生成し、
  //   コード・context・テンプレートのいずれにも実値を残さない。
  /** 独自ドメイン名（例: app.example.com）。環境変数経由で注入しリポジトリに残さない。 */
  domainName?: string;
  /** ホストゾーン名（例: example.com）。 */
  hostedZoneName?: string;
  /** ★ 今回追加: ホストゾーンID。fromLookup を避け cdk.context.json への記録を防ぐため明示。 */
  hostedZoneId?: string;
}

/**
 * ベースの3層アーキテクチャ。
 * 監視スタックから参照できるように、主要リソースを public readonly で公開する。
 */
export class BaseInfraStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;
  public readonly asg: autoscaling.AutoScalingGroup;
  public readonly db: rds.DatabaseInstance;
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: BaseInfraStackProps) {
    super(scope, id, props);

    // ★ 今回変更: HTTPS 化の条件にゾーンIDも必須化（fromLookup を使わないため）
    const httpsMode = !!(props.domainName && props.hostedZoneName && props.hostedZoneId);
    const ORIGIN_HEADER = 'X-Origin-Verify';

    // ★ 今回追加: カスタムヘッダーの秘密値を Secrets Manager で生成する。
    //   secretValue.unsafeUnwrap() はテンプレートに「実値」ではなく
    //   {{resolve:secretsmanager:...}} という動的参照を埋め込む（値は deploy 時に解決）。
    //   → 合成テンプレートにもソースにも平文の秘密が載らない。
    const originVerifySecret = new secretsmanager.Secret(this, 'OriginVerifySecret', {
      description: 'Shared secret for CloudFront -> ALB custom header verification',
      generateSecretString: { passwordLength: 32, excludePunctuation: true },
    });
    const originHeaderValue = originVerifySecret.secretValue.unsafeUnwrap();

    // ---- VPC: 2AZ・3層サブネット（Public / App(Private) / DB(Isolated)）----
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1, // ※ NAT は課金対象。SSM 用エンドポイント導入時に 0 にする余地あり
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'App', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'Db', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    this.vpc = vpc;

    // ---- セキュリティグループ（3層・最小権限）----
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'ALB: ingress only from CloudFront',
      allowAllOutbound: false, // egress はターゲット登録時に必要分だけ自動追加
    });
    const appSg = new ec2.SecurityGroup(this, 'AppSg', {
      vpc,
      description: 'App tier (EC2): ingress only from ALB',
      allowAllOutbound: true, // パッケージ取得・AWS API・VPCエンドポイント用に egress は許可
    });
    const dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc,
      description: 'DB tier (RDS): ingress only from App tier',
      allowAllOutbound: false, // RDS は自発的な outbound を持たない
    });

    // CloudFront のオリジン向けマネージドプレフィックスリストを名前から解決し、
    // 「ALB は CloudFront からのみ」に絞る（CloudFront 迂回の直アクセスを防ぐ）。
    const cfPrefixList = new cr.AwsCustomResource(this, 'CloudFrontPrefixList', {
      onUpdate: {
        service: 'EC2',
        action: 'describeManagedPrefixLists',
        parameters: {
          Filters: [
            { Name: 'prefix-list-name', Values: ['com.amazonaws.global.cloudfront.origin-facing'] },
          ],
        },
        physicalResourceId: cr.PhysicalResourceId.of('CloudFrontOriginFacingPrefixList'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });
    const cfPrefixListId = cfPrefixList.getResponseField('PrefixLists.0.PrefixListId');
    const albPort = httpsMode ? 443 : 80;
    albSg.addIngressRule(
      ec2.Peer.prefixList(cfPrefixListId),
      ec2.Port.tcp(albPort),
      `Port ${albPort} from CloudFront edge locations only`,
    );

    // ---- ALB（インターネット向け・Publicサブネット）----
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
    });

    // 独自ドメイン指定時のみ ACM 証明書と Route53 Alias を用意（CloudFront→ALB の HTTPS 化）。
    let listenerCert: acm.ICertificate | undefined;
    if (httpsMode) {
      // ★ 今回変更: fromLookup ではなく属性から参照（cdk.context.json に書き込まれない）
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: props.hostedZoneId!,
        zoneName: props.hostedZoneName!,
      });
      listenerCert = new acm.Certificate(this, 'AlbCert', {
        domainName: props.domainName!,
        validation: acm.CertificateValidation.fromDns(zone),
      });
      new route53.ARecord(this, 'AlbAlias', {
        zone,
        recordName: props.domainName!,
        target: route53.RecordTarget.fromAlias(
          new route53targets.LoadBalancerTarget(this.alb),
        ),
      });
    }

    // リスナー: 既定は 403 拒否。カスタムヘッダー一致時のみ転送（① カスタムヘッダー検証）。
    const listener = this.alb.addListener('WebListener', {
      port: albPort,
      open: false,
      ...(listenerCert ? { certificates: [listenerCert] } : {}),
      defaultAction: elbv2.ListenerAction.fixedResponse(403, {
        contentType: 'text/plain',
        messageBody: 'Forbidden',
      }),
    });

    // ---- Auto Scaling Group + EC2（Privateサブネット）----
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'dnf install -y httpd',
      'systemctl enable --now httpd',
      'echo "<h1>Hello from $(hostname -f)</h1>" > /var/www/html/index.html',
    );

    this.asg = new autoscaling.AutoScalingGroup(this, 'AppAsg', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      minCapacity: 2,
      maxCapacity: 4,
      desiredCapacity: 2,
      userData,
      securityGroup: appSg,
    });

    this.asg.scaleOnCpuUtilization('CpuTargetTracking', {
      targetUtilizationPercent: 60,
    });

    this.asg.role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
    );
    this.asg.role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
    );

    // カスタムヘッダーが一致したときだけ転送する優先ルール。無い/違うリクエストは既定の403。
    this.targetGroup = listener.addTargets('AppFleet', {
      port: 80,
      targets: [this.asg],
      healthCheck: { path: '/', healthyHttpCodes: '200' },
      priority: 10,
      // ★ 今回変更: 比較値は Secrets Manager の動的参照（テンプレートに実値が出ない）
      conditions: [elbv2.ListenerCondition.httpHeader(ORIGIN_HEADER, [originHeaderValue])],
    });

    // ---- RDS（Multi-AZ・Isolatedサブネット）----
    // 転送中の暗号化(TLS)を強制（非TLS接続を RDS 側で拒否）。実接続のTLS化はアプリ側の責務。
    const dbParams = new rds.ParameterGroup(this, 'DbParams', {
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_8_0,
      }),
      parameters: { require_secure_transport: 'ON' },
    });
    this.db = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_8_0,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      multiAz: true,
      allocatedStorage: 20,
      credentials: rds.Credentials.fromGeneratedSecret('admin'),
      removalPolicy: cdk.RemovalPolicy.DESTROY, // 学習用。本番は RETAIN
      deletionProtection: false,
      securityGroups: [dbSg],
      parameterGroup: dbParams,
    });
    this.db.connections.allowDefaultPortFrom(this.asg, 'Allow app tier to DB');

    // ---- S3（静的コンテンツ用・非公開バケット）----
    this.bucket = new s3.Bucket(this, 'StaticBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // 学習用
      autoDeleteObjects: true,
    });

    // オリジンに検証用カスタムヘッダーを付与。HTTPS モードでは独自ドメインへ HTTPS 接続。
    const albOrigin = httpsMode
      ? new origins.HttpOrigin(props.domainName!, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          // ★ 今回変更: ヘッダー値は Secrets Manager の動的参照
          customHeaders: { [ORIGIN_HEADER]: originHeaderValue },
        })
      : new origins.LoadBalancerV2Origin(this.alb, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          // ★ 今回変更: ヘッダー値は Secrets Manager の動的参照
          customHeaders: { [ORIGIN_HEADER]: originHeaderValue },
        });

    // ---- CloudFront（既定=ALB / /static/*=S3）----
    this.distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: '3-tier web app distribution',
      defaultBehavior: {
        origin: albOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      },
      additionalBehaviors: {
        '/static/*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
      },
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
    });
  }
}
