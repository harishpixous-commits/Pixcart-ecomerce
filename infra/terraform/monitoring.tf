resource "aws_sns_topic" "alarms" {
  name = "${local.n}-alarms"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alarms = {
    "alb-5xx" = {
      namespace = "AWS/ApplicationELB", metric = "HTTPCode_Target_5XX_Count", stat = "Sum", threshold = 20, op = "GreaterThanThreshold"
      dims      = { LoadBalancer = aws_lb.main.arn_suffix }, desc = "More than 20 server errors in 5 minutes"
    }
    "alb-latency" = {
      namespace = "AWS/ApplicationELB", metric = "TargetResponseTime", stat = "Average", threshold = 1.5, op = "GreaterThanThreshold"
      dims      = { LoadBalancer = aws_lb.main.arn_suffix }, desc = "Average response time above 1.5 s"
    }
    "api-unhealthy" = {
      namespace = "AWS/ApplicationELB", metric = "UnHealthyHostCount", stat = "Maximum", threshold = 0, op = "GreaterThanThreshold"
      dims      = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.api.arn_suffix }, desc = "An API task is failing health checks"
    }
    "db-cpu" = {
      namespace = "AWS/RDS", metric = "CPUUtilization", stat = "Average", threshold = 80, op = "GreaterThanThreshold"
      dims      = { DBInstanceIdentifier = aws_db_instance.main.identifier }, desc = "Database CPU above 80%"
    }
    "db-storage" = {
      namespace = "AWS/RDS", metric = "FreeStorageSpace", stat = "Minimum", threshold = 5368709120, op = "LessThanThreshold"
      dims      = { DBInstanceIdentifier = aws_db_instance.main.identifier }, desc = "Less than 5 GB of database storage left"
    }
    "db-connections" = {
      namespace = "AWS/RDS", metric = "DatabaseConnections", stat = "Maximum", threshold = 300, op = "GreaterThanThreshold"
      dims      = { DBInstanceIdentifier = aws_db_instance.main.identifier }, desc = "Unusually many database connections"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "this" {
  for_each            = local.alarms
  alarm_name          = "${local.n}-${each.key}"
  alarm_description   = each.value.desc
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  statistic           = each.value.stat
  dimensions          = each.value.dims
  period              = 300
  evaluation_periods  = 1
  threshold           = each.value.threshold
  comparison_operator = each.value.op
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# Application errors in the JSON logs (level ERROR), counted per minute.
resource "aws_cloudwatch_log_metric_filter" "api_errors" {
  name           = "${local.n}-api-errors"
  log_group_name = aws_cloudwatch_log_group.app["api"].name
  pattern        = "{ $.level = \"ERROR\" }"
  metric_transformation {
    name      = "ApiErrors"
    namespace = "PixCart"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "api_errors" {
  alarm_name          = "${local.n}-api-errors"
  alarm_description   = "More than 10 logged errors in 5 minutes"
  namespace           = "PixCart"
  metric_name         = "ApiErrors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}
