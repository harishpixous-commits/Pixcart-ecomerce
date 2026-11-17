variable "name" {
  description = "Short name used in every resource name"
  type        = string
  default     = "pixcart"
}

variable "environment" {
  description = "production or staging"
  type        = string
  default     = "production"
}

variable "region" {
  type    = string
  default = "ap-south-1" # Mumbai: keeps Indian customer data in India
}

variable "domain" {
  description = "Shop domain, e.g. www.yourshop.in. Its Route 53 hosted zone must exist."
  type        = string
}

variable "hosted_zone" {
  description = "Route 53 hosted zone name, e.g. yourshop.in"
  type        = string
}

variable "media_domain" {
  description = "Domain for product images, e.g. cdn.yourshop.in"
  type        = string
}

variable "github_repository" {
  description = "owner/repo allowed to deploy through GitHub Actions OIDC"
  type        = string
}

variable "image_tag" {
  description = "Container image tag to run; the deploy workflow passes the commit SHA"
  type        = string
  default     = "latest"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "db_allocated_storage" {
  type    = number
  default = 50
}

variable "db_multi_az" {
  type    = bool
  default = true
}

variable "api_cpu" {
  type    = number
  default = 512
}

variable "api_memory" {
  type    = number
  default = 1024
}

variable "api_desired" {
  type    = number
  default = 2
}

variable "web_cpu" {
  type    = number
  default = 512
}

variable "web_memory" {
  type    = number
  default = 1024
}

variable "web_desired" {
  type    = number
  default = 2
}

variable "alarm_email" {
  description = "Email that receives CloudWatch alarms"
  type        = string
}

variable "app_env" {
  description = "Non-secret API settings (PLATFORM_LEGAL_NAME, SMS_PROVIDER, PAYOUT_MODE, SHIPPING_PROVIDER, ...)"
  type        = map(string)
  default     = {}
}
