import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';

export interface CloudFrontMonitoringStackProps extends cdk.StackProps {
  alarmEmail: string;
  /** 東京スタックの distributionId（crossRegionReferences 経由で受け取る）*/
  distributionId: string;
}

/**
 * CloudFront のメトリクスは us-east-1 に集約される。
 * 「アラームはメトリクスと同一リージョンのスタックに置く」という CDK の制約により、
 * CloudFront のアラームだけはこの us-east-1 スタックに分離する。
 *
 * SNS トピックもリージョンを越えられないため、東京とは別にここで作成する。
 */
export class CloudFrontMonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CloudFrontMonitoringStackProps) {
    super(scope, id, props);

    const topic = new sns.Topic(this, 'CfAlarmTopic');
    topic.addSubscription(new subs.EmailSubscription(props.alarmEmail));
    const action = new cw_actions.SnsAction(topic);

    // 5xx エラー率（%）
    const cf5xx = this.cloudFrontMetric(props.distributionId, '5xxErrorRate');
    const a5xx = cf5xx.createAlarm(this, 'CloudFront5xxRate', {
      threshold: 5,
      evaluationPeriods: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'CloudFront 5xx エラー率が 5% を超過',
    });
    a5xx.addAlarmAction(action);
    a5xx.addOkAction(action);

    // 4xx エラー率（%）
    const cf4xx = this.cloudFrontMetric(props.distributionId, '4xxErrorRate');
    const a4xx = cf4xx.createAlarm(this, 'CloudFront4xxRate', {
      threshold: 10,
      evaluationPeriods: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'CloudFront 4xx エラー率が 10% を超過',
    });
    a4xx.addAlarmAction(action);
    a4xx.addOkAction(action);
  }

  private cloudFrontMetric(distributionId: string, metricName: string): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: 'AWS/CloudFront',
      metricName,
      dimensionsMap: { DistributionId: distributionId },
      statistic: cloudwatch.Stats.AVERAGE,
      period: cdk.Duration.minutes(5),
      // このスタック自体が us-east-1 なので region 指定は不要（同一リージョン）
    });
  }
}
