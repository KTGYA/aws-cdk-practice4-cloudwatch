import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';

export interface MonitoringStackProps extends cdk.StackProps {
  alarmEmail: string;
  alb: elbv2.IApplicationLoadBalancer;
  targetGroup: elbv2.IApplicationTargetGroup;
  asg: autoscaling.IAutoScalingGroup;
  db: rds.IDatabaseInstance;
  bucket: s3.IBucket;
  distribution: cloudfront.IDistribution; // ダッシュボード表示用（アラームは別スタック）
}

/**
 * 東京リージョンの監視。EC2 / RDS / ALB / S3 のアラームと通知、ダッシュボードを担う。
 * ダッシュボードはリージョンをまたげるので CloudFront のグラフもここに同居させる。
 */
export class MonitoringStack extends cdk.Stack {
  private readonly alarmAction: cw_actions.SnsAction;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    // ---- 通知先（SNS + メール購読）----
    const topic = new sns.Topic(this, 'AlarmTopic');
    topic.addSubscription(new subs.EmailSubscription(props.alarmEmail));
    this.alarmAction = new cw_actions.SnsAction(topic);

    // ---- EC2 / Auto Scaling: グループ平均 CPU ----
    // ASG 単位の CPU は AWS/EC2 名前空間 + AutoScalingGroupName ディメンションで取得
    const asgCpu = new cloudwatch.Metric({
      namespace: 'AWS/EC2',
      metricName: 'CPUUtilization',
      dimensionsMap: { AutoScalingGroupName: props.asg.autoScalingGroupName },
      statistic: cloudwatch.Stats.AVERAGE,
      period: cdk.Duration.minutes(5),
    });
    this.makeAlarm('Ec2HighCpu', asgCpu, {
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'ASG 平均 CPU が 80% を超過',
    });
    // メモリ・ディスク使用率は EC2 の既定メトリクスに無いため、SsmStack が配布する
    // CloudWatch Agent が CWAgent 名前空間に出力する。AutoScalingGroupName 次元で集約済み。
    const asgMemory = this.cwAgentMetric('mem_used_percent', props.asg.autoScalingGroupName);
    const asgDisk = this.cwAgentMetric('disk_used_percent', props.asg.autoScalingGroupName);
    this.makeAlarm('Ec2HighMemory', asgMemory, {
      threshold: 85,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      // エージェント未送信時にデータ欠損で誤発報しないよう、欠損は「正常扱い」
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'ASG 平均メモリ使用率が 85% を超過',
    });
    this.makeAlarm('Ec2HighDisk', asgDisk, {
      threshold: 80,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'ASG 平均ディスク使用率が 80% を超過',
    });

    // ---- RDS ----
    this.makeAlarm('RdsHighCpu', props.db.metricCPUUtilization(), {
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'RDS CPU が 80% を超過',
    });
    this.makeAlarm('RdsLowStorage', props.db.metricFreeStorageSpace(), {
      threshold: 2 * 1024 * 1024 * 1024, // 2 GiB
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      alarmDescription: 'RDS 空きストレージが 2GiB を下回った',
    });
    this.makeAlarm('RdsHighConnections', props.db.metricDatabaseConnections(), {
      threshold: 100,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'RDS 接続数が多い',
    });

    // ---- ALB ----
    const alb5xx = props.alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, {
      statistic: cloudwatch.Stats.SUM,
      period: cdk.Duration.minutes(5),
    });
    this.makeAlarm('Alb5xx', alb5xx, {
      threshold: 10,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'ALB が 5xx を多発',
    });

    const albLatency = props.alb.metrics.targetResponseTime({
      statistic: 'p95',
      period: cdk.Duration.minutes(5),
    });
    this.makeAlarm('AlbHighLatency', albLatency, {
      threshold: 1, // 秒
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'ALB ターゲット応答 p95 が 1 秒超',
    });

    const healthyHosts = props.targetGroup.metrics.healthyHostCount({
      statistic: cloudwatch.Stats.MINIMUM,
      period: cdk.Duration.minutes(1),
    });
    this.makeAlarm('AlbNoHealthyHosts', healthyHosts, {
      threshold: 1,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription: '正常なターゲットが存在しない',
    });

    // ---- S3: バケットサイズ（無料の日次ストレージメトリクス）----
    const bucketSize = new cloudwatch.Metric({
      namespace: 'AWS/S3',
      metricName: 'BucketSizeBytes',
      dimensionsMap: {
        BucketName: props.bucket.bucketName,
        StorageType: 'StandardStorage',
      },
      statistic: cloudwatch.Stats.AVERAGE,
      period: cdk.Duration.days(1),
    });
    // ※ リクエスト数などの詳細メトリクスは有料。学習用途では無効のままにする。

    // ---- CloudFront メトリクス（ダッシュボード表示専用・リージョンは us-east-1）----
    const cf5xx = this.cloudFrontMetric(props.distribution.distributionId, '5xxErrorRate');
    const cf4xx = this.cloudFrontMetric(props.distribution.distributionId, '4xxErrorRate');

    // ---- ダッシュボード（1枚に集約・CloudFront はクロスリージョン参照）----
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'WebApp-Observability',
    });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({ title: 'EC2 (ASG) CPU', left: [asgCpu], width: 12 }),
      new cloudwatch.GraphWidget({
        title: 'EC2 (ASG) Memory / Disk (CWAgent)',
        left: [asgMemory],
        right: [asgDisk],
        leftYAxis: { min: 0, max: 100, label: 'Memory %' },
        rightYAxis: { min: 0, max: 100, label: 'Disk %' },
        width: 12,
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'RDS CPU / Connections',
        left: [props.db.metricCPUUtilization()],
        right: [props.db.metricDatabaseConnections()],
        width: 12,
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({ title: 'ALB 5xx', left: [alb5xx], width: 8 }),
      new cloudwatch.GraphWidget({ title: 'ALB p95 Latency', left: [albLatency], width: 8 }),
      new cloudwatch.GraphWidget({ title: 'ALB Healthy Hosts', left: [healthyHosts], width: 8 }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({ title: 'S3 Bucket Size', left: [bucketSize], width: 12 }),
      new cloudwatch.GraphWidget({
        title: 'CloudFront Error Rate (us-east-1)',
        left: [cf5xx, cf4xx],
        width: 12,
      }),
    );
  }

  /** メトリクスからアラームを生成し、SNS 通知アクションを付与する共通ヘルパー */
  private makeAlarm(
    id: string,
    metric: cloudwatch.Metric, // ★ 修正: IMetric には createAlarm が無いため具象 Metric 型にする
    props: cloudwatch.CreateAlarmOptions,
  ): cloudwatch.Alarm {
    const alarm = metric.createAlarm(this, id, props);
    alarm.addAlarmAction(this.alarmAction);
    alarm.addOkAction(this.alarmAction); // 復旧時も通知
    return alarm;
  }

  /** CloudWatch Agent が出力するメトリクス（CWAgent 名前空間・ASG 次元で集約）*/
  private cwAgentMetric(metricName: string, asgName: string): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: 'CWAgent',
      metricName,
      dimensionsMap: { AutoScalingGroupName: asgName },
      statistic: cloudwatch.Stats.AVERAGE,
      period: cdk.Duration.minutes(5),
    });
  }

  /**
   * CloudFront メトリクス（メトリクスのリージョンは us-east-1）
   * ★ 修正: CloudFront のメトリクスのディメンションは DistributionId のみ。
   *   'Region' ディメンションは存在しないため付与しない（付けると空データになる）。
   */
  private cloudFrontMetric(distributionId: string, metricName: string): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: 'AWS/CloudFront',
      metricName,
      dimensionsMap: { DistributionId: distributionId },
      statistic: cloudwatch.Stats.AVERAGE,
      period: cdk.Duration.minutes(5),
      region: 'us-east-1', // ダッシュボードのウィジェットはリージョンをまたげる
    });
  }
}
