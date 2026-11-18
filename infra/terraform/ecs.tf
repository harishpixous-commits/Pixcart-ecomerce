resource "aws_ecs_cluster" "main" {
  name = local.n
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_service_discovery_http_namespace" "main" {
  name = local.n
}

resource "aws_cloudwatch_log_group" "app" {
  for_each          = toset(["api", "web", "migrate"])
  name              = "/ecs/${local.n}/${each.key}"
  retention_in_days = 30
}

locals {
  registry = "${data.aws_caller_identity.me.account_id}.dkr.ecr.${var.region}.amazonaws.com"
  api_env = merge({
    ENVIRONMENT         = "production" # staging runs with the same hardening; it differs only by keys and data
    PUBLIC_WEB_URL      = "https://${var.domain}"
    CORS_ORIGINS        = "https://${var.domain}"
    COOKIE_SECURE       = "true"
    TRUST_PROXY_HEADERS = "true"
    TRUSTED_PROXY_COUNT = "1"
    LOG_FORMAT          = "json"
    STORAGE_BACKEND     = "s3"
    S3_BUCKET           = aws_s3_bucket.media.id
    S3_PRIVATE_BUCKET   = aws_s3_bucket.private.id
    S3_REGION           = var.region
    MEDIA_BASE_URL      = "https://${var.media_domain}"
    SMS_PROVIDER        = "msg91"
    RUN_JOBS            = "true"
  }, var.app_env)
  api_secrets = concat(
    [for k in keys(local.generated) : { name = k, valueFrom = "${aws_secretsmanager_secret.generated.arn}:${k}::" }],
    [for k in local.integration_keys : { name = k, valueFrom = "${aws_secretsmanager_secret.integrations.arn}:${k}::" }],
  )
  api_log = { for k in ["api", "migrate"] : k => {
    logDriver = "awslogs"
    options   = { awslogs-group = aws_cloudwatch_log_group.app[k].name, awslogs-region = var.region, awslogs-stream-prefix = k }
  } }
  api_image = "${local.registry}/${var.name}/api:${var.image_tag}"

}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.n}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([{
    name             = "api"
    image            = local.api_image
    essential        = true
    portMappings     = [{ name = "api", containerPort = 8000, protocol = "tcp" }]
    environment      = [for k, v in local.api_env : { name = k, value = v }]
    secrets          = local.api_secrets
    logConfiguration = local.api_log["api"]
    healthCheck = {
      command     = ["CMD-SHELL", "python -c \"import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3).status == 200 else 1)\""]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 20
    }
  }])
}

# One-off task the deploy pipeline runs before updating services.
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.n}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name             = "migrate"
    image            = local.api_image
    essential        = true
    command          = ["alembic", "upgrade", "head"]
    environment      = [for k, v in merge(local.api_env, { RUN_JOBS = "false" }) : { name = k, value = v }]
    secrets          = local.api_secrets
    logConfiguration = local.api_log["migrate"]
  }])
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${local.n}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.web_cpu
  memory                   = var.web_memory
  execution_role_arn       = aws_iam_role.execution.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([{
    name         = "web"
    image        = "${local.registry}/${var.name}/web:${var.image_tag}"
    essential    = true
    portMappings = [{ name = "web", containerPort = 3000, protocol = "tcp" }]
    environment = [
      { name = "API_ORIGIN", value = "http://api:8000" }, # Service Connect name of the API
      { name = "PUBLIC_WEB_URL", value = "https://${var.domain}" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options   = { awslogs-group = aws_cloudwatch_log_group.app["web"].name, awslogs-region = var.region, awslogs-stream-prefix = "web" }
    }
  }])
}

resource "aws_ecs_service" "api" {
  name                              = "api"
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.api.arn
  desired_count                     = var.api_desired
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 30
  enable_execute_command            = true
  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.app.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 8000
  }
  service_connect_configuration {
    enabled   = true
    namespace = aws_service_discovery_http_namespace.main.arn
    service {
      port_name = "api"
      client_alias {
        port     = 8000
        dns_name = "api"
      }
    }
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  # The deploy workflow registers new task definition revisions; autoscaling owns the count.
  lifecycle { ignore_changes = [task_definition, desired_count] }
  depends_on = [aws_lb_listener.https]
}

resource "aws_ecs_service" "web" {
  name                              = "web"
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.web.arn
  desired_count                     = var.web_desired
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 30
  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.app.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }
  service_connect_configuration {
    enabled   = true
    namespace = aws_service_discovery_http_namespace.main.arn
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  lifecycle { ignore_changes = [task_definition, desired_count] }
  depends_on = [aws_lb_listener.https, aws_ecs_service.api]
}

# ---------------------------------------------------------------- autoscaling on CPU
resource "aws_appautoscaling_target" "svc" {
  for_each           = { api = aws_ecs_service.api.name, web = aws_ecs_service.web.name }
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${each.value}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = 2
  max_capacity       = 10
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each           = aws_appautoscaling_target.svc
  name               = "${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = each.value.service_namespace
  resource_id        = each.value.resource_id
  scalable_dimension = each.value.scalable_dimension
  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    predefined_metric_specification { predefined_metric_type = "ECSServiceAverageCPUUtilization" }
  }
}
