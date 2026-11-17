terraform {
  required_version = ">= 1.6"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # Keep state in S3 with locking. Create the bucket once by hand, then: terraform init -backend-config=backend.hcl
  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags { tags = { Project = var.name, Environment = var.environment, ManagedBy = "terraform" } }
}

# CloudFront certificates must live in us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags { tags = { Project = var.name, Environment = var.environment, ManagedBy = "terraform" } }
}

data "aws_caller_identity" "me" {}
data "aws_availability_zones" "available" { state = "available" }
