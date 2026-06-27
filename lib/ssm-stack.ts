import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';

export interface SsmStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  asg: autoscaling.IAutoScalingGroup;
}

/**
 * SSM スタック。ベースの3層構成・CloudWatch 監視とは独立した別スタック。
 * 役割:
 *   1) インターフェース型 VPC エンドポイント（Session Manager / CloudWatch を VPC 内に閉じる）
 *   2) Session Manager のセッションログを CloudWatch Logs に出力
 *   3) CloudWatch Agent を ASG インスタンスへ配布し、メモリ/ディスク使用率を取得
 *
 * 前提: インスタンスロールへの権限付与（SSM Core / CloudWatchAgentServerPolicy）は
 *       BaseInfraStack 側で実施済み。
 */
export class SsmStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SsmStackProps) {
    super(scope, id, props);

    const { vpc, asg } = props;

    // ---- インターフェース型 VPC エンドポイント ----
    // Session Manager / CloudWatch のトラフィックを NAT やインターネット経由ではなく
    // VPC 内に閉じる（プライベート接続）。図の「VPC EndPoint」がこれ。
    const endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', {
      vpc,
      description: 'HTTPS from within the VPC to interface endpoints',
      allowAllOutbound: true,
    });
    endpointSg.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      'HTTPS from VPC to AWS service endpoints',
    );

    const endpointSubnets: ec2.SubnetSelection = {
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    };

    const interfaceServices: { id: string; service: ec2.InterfaceVpcEndpointAwsService }[] = [
      { id: 'Ssm', service: ec2.InterfaceVpcEndpointAwsService.SSM },
      { id: 'SsmMessages', service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES },
      { id: 'Ec2Messages', service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES },
      { id: 'CwLogs', service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS },
      { id: 'CwMonitoring', service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING },
    ];
    for (const { id, service } of interfaceServices) {
      new ec2.InterfaceVpcEndpoint(this, `${id}Endpoint`, {
        vpc,
        service,
        subnets: endpointSubnets,
        securityGroups: [endpointSg],
        privateDnsEnabled: true,
      });
    }

    // S3 用ゲートウェイ型エンドポイント（無料。SSM Agent / CW Agent が S3 を使う場面に備える）
    // ※ ゲートウェイ型は CloudWatch メトリクスを持たない（インターフェース型との違い）。
    new ec2.GatewayVpcEndpoint(this, 'S3GatewayEndpoint', {
      vpc,
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // ---- Session Manager のセッションログ用 CloudWatch Logs ----
    const sessionLogGroup = new logs.LogGroup(this, 'SessionLogGroup', {
      logGroupName: '/ssm/session-logs',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // 学習用
    });

    // ---- Session Manager 設定ドキュメント（ログを CloudWatch Logs にストリーミング）----
    // ⚠️ 名前 'SSM-SessionManagerRunShell' はアカウント/リージョンに1つだけの特別な予約名。
    //    既にこのドキュメントが存在するアカウントでは作成が衝突して deploy に失敗する。
    //    その場合はこのリソースを外す（既存の設定を使う）か、既存を削除してから deploy する。
    new ssm.CfnDocument(this, 'SessionPreferences', {
      name: 'SSM-SessionManagerRunShell',
      documentType: 'Session',
      documentFormat: 'JSON',
      updateMethod: 'NewVersion',
      content: {
        schemaVersion: '1.0',
        description: 'Session Manager preferences with CloudWatch Logs streaming',
        sessionType: 'Standard_Stream',
        inputs: {
          // ★ 修正: 正しいキー名は cloudWatchLogGroupName（誤: cloudWatchGroupName）
          cloudWatchLogGroupName: sessionLogGroup.logGroupName,
          cloudWatchEncryptionEnabled: false,
          cloudWatchStreamingEnabled: true,
          idleSessionTimeout: '20',
          runAsEnabled: false,
          shellProfile: { linux: '', windows: '' },
        },
      },
    });

    // ---- CloudWatch Agent 設定（SSM Parameter Store）----
    // ⚠️ パラメータ名は 'AmazonCloudWatch-' で始める必要がある。
    //    CloudWatchAgentServerPolicy の ssm:GetParameter が
    //    parameter/AmazonCloudWatch-* に限定されており、別名だとエージェントが設定を読めない。
    const agentConfig = {
      agent: { metrics_collection_interval: 60 },
      metrics: {
        namespace: 'CWAgent',
        append_dimensions: {
          AutoScalingGroupName: '${aws:AutoScalingGroupName}',
          InstanceId: '${aws:InstanceId}',
        },
        aggregation_dimensions: [['AutoScalingGroupName']],
        metrics_collected: {
          // ★ EC2 の既定メトリクスに含まれないメモリ・ディスクをここで取得する
          mem: { measurement: ['mem_used_percent'] },
          // ★ 修正: 正しいキー名は resources（誤: resource）
          disk: { measurement: ['used_percent'], resources: ['/'] },
        },
      },
    };
    const agentParam = new ssm.StringParameter(this, 'CwAgentConfig', {
      parameterName: 'AmazonCloudWatch-monitoring-config',
      stringValue: JSON.stringify(agentConfig),
      tier: ssm.ParameterTier.STANDARD,
    });

    // ---- ASG インスタンスへ CloudWatch Agent を導入・設定（SSM Association）----
    // ASG のインスタンスには自動で tag:aws:autoscaling:groupName が付くので、それで対象指定。
    // ★ 修正: CfnAssociation のターゲットのプロパティ名は values（誤: value）
    const asgTarget = [
      { key: 'tag:aws:autoscaling:groupName', values: [asg.autoScalingGroupName] },
    ];

    // 1) エージェントのインストール（AWS 管理ドキュメント）
    const installAgent = new ssm.CfnAssociation(this, 'InstallCwAgent', {
      name: 'AWS-ConfigureAWSPackage',
      associationName: 'install-cloudwatch-agent',
      targets: asgTarget,
      parameters: {
        action: ['Install'],
        name: ['AmazonCloudWatchAgent'],
      },
    });

    // 2) Parameter Store の設定値でエージェントを構成・起動
    const configureAgent = new ssm.CfnAssociation(this, 'ConfigureCwAgent', {
      name: 'AmazonCloudWatch-ManageAgent',
      associationName: 'configure-cloudwatch-agent',
      targets: asgTarget,
      parameters: {
        action: ['configure'],
        mode: ['ec2'],
        optionalConfigurationSource: ['ssm'],
        optionalConfigurationLocation: [agentParam.parameterName],
        optionalRestart: ['yes'],
      },
    });
    // インストール → 設定 の順序、および設定時にパラメータが存在することを担保
    configureAgent.addDependency(installAgent);
    configureAgent.node.addDependency(agentParam);

    new cdk.CfnOutput(this, 'SessionLogGroupName', {
      value: sessionLogGroup.logGroupName,
      description: 'Session Manager のログ出力先 CloudWatch Logs グループ',
    });
  }
}
