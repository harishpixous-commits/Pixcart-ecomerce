output "site_url" { value = "https://${var.domain}" }
output "media_base_url" { value = "https://${var.media_domain}" }
output "ecr_api" { value = aws_ecr_repository.repo["api"].repository_url }
output "ecr_web" { value = aws_ecr_repository.repo["web"].repository_url }
output "ecs_cluster" { value = aws_ecs_cluster.main.name }
output "private_subnets" { value = join(",", aws_subnet.private[*].id) }
output "app_security_group" { value = aws_security_group.app.id }
output "deploy_role_arn" { value = aws_iam_role.deploy.arn }
output "integrations_secret" {
  description = "Fill the third-party keys here (AWS console → Secrets Manager), then redeploy the API"
  value       = aws_secretsmanager_secret.integrations.name
}
output "webhook_urls" {
  value = {
    razorpay   = "https://${var.domain}/api/payments/razorpay/webhook"
    razorpayx  = "https://${var.domain}/api/webhooks/razorpayx"
    shiprocket = "https://${var.domain}/api/webhooks/shiprocket"
  }
}
output "outbound_ip" {
  description = "The servers' fixed outbound IP (NAT). Allowlist it in RazorpayX → Developer controls."
  value       = aws_eip.nat.public_ip
}
