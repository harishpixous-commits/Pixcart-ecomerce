# Two secrets:
#  - "generated": created and rotated by Terraform (database URL, JWT secret, encryption key).
#  - "integrations": third-party keys. Terraform creates it with empty values and never overwrites it;
#    fill the values in the AWS console (Secrets Manager) and redeploy the API.

resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "random_bytes" "fernet" {
  length = 32
}

locals {
  # Fernet keys are URL-safe base64 of 32 bytes.
  fernet_key = replace(replace(random_bytes.fernet.base64, "+", "-"), "/", "_")
  generated = {
    DATABASE_URL         = "postgresql+asyncpg://pixcart:${random_password.db.result}@${aws_db_instance.main.address}:5432/pixcart?ssl=require"
    JWT_SECRET           = random_password.jwt.result
    FIELD_ENCRYPTION_KEY = local.fernet_key
  }
  integration_keys = [
    "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET",
    "RAZORPAYX_ACCOUNT_NUMBER", "RAZORPAYX_WEBHOOK_SECRET",
    "MSG91_AUTH_KEY", "MSG91_OTP_TEMPLATE_ID",
    "SMTP_USER", "SMTP_PASSWORD",
    "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_TOKEN",
    "SHIPROCKET_EMAIL", "SHIPROCKET_PASSWORD", "SHIPROCKET_WEBHOOK_TOKEN",
    "ANTHROPIC_API_KEY", "SENTRY_DSN",
  ]
}

resource "aws_secretsmanager_secret" "generated" {
  name                    = "${local.n}/generated"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "generated" {
  secret_id     = aws_secretsmanager_secret.generated.id
  secret_string = jsonencode(local.generated)
}

resource "aws_secretsmanager_secret" "integrations" {
  name                    = "${local.n}/integrations"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "integrations" {
  secret_id     = aws_secretsmanager_secret.integrations.id
  secret_string = jsonencode({ for k in local.integration_keys : k => "" })
  lifecycle { ignore_changes = [secret_string] }
}
