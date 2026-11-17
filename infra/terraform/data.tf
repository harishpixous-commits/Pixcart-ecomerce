# ---------------------------------------------------------------- PostgreSQL
resource "random_password" "db" {
  length  = 32
  special = false # goes into a URL
}

resource "aws_db_subnet_group" "main" {
  name       = local.n
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_parameter_group" "pg16" {
  name   = "${local.n}-pg16"
  family = "postgres16"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "500" # log queries slower than 500 ms
  }
}

resource "aws_db_instance" "main" {
  identifier                      = local.n
  engine                          = "postgres"
  engine_version                  = "16"
  instance_class                  = var.db_instance_class
  allocated_storage               = var.db_allocated_storage
  max_allocated_storage           = var.db_allocated_storage * 4
  storage_type                    = "gp3"
  storage_encrypted               = true
  db_name                         = "pixcart"
  username                        = "pixcart"
  password                        = random_password.db.result
  db_subnet_group_name            = aws_db_subnet_group.main.name
  vpc_security_group_ids          = [aws_security_group.db.id]
  parameter_group_name            = aws_db_parameter_group.pg16.name
  multi_az                        = var.db_multi_az
  backup_retention_period         = 14
  backup_window                   = "20:00-21:00" # 01:30-02:30 IST
  maintenance_window              = "sun:21:30-sun:22:30"
  auto_minor_version_upgrade      = true
  deletion_protection             = true
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${local.n}-final"
  performance_insights_enabled    = true
  enabled_cloudwatch_logs_exports = ["postgresql"]
  copy_tags_to_snapshot           = true
}

# ---------------------------------------------------------------- S3: public product images (via CloudFront) and private KYC documents
resource "aws_s3_bucket" "media" {
  bucket = "${local.n}-media-${data.aws_caller_identity.me.account_id}"
}

resource "aws_s3_bucket" "private" {
  bucket = "${local.n}-private-${data.aws_caller_identity.me.account_id}"
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "private" {
  bucket                  = aws_s3_bucket.private.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "both" {
  for_each = { media = aws_s3_bucket.media.id, private = aws_s3_bucket.private.id }
  bucket   = each.value
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_versioning" "private" {
  bucket = aws_s3_bucket.private.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_ownership_controls" "both" {
  for_each = { media = aws_s3_bucket.media.id, private = aws_s3_bucket.private.id }
  bucket   = each.value
  rule { object_ownership = "BucketOwnerEnforced" }
}

# ---------------------------------------------------------------- container registry
resource "aws_ecr_repository" "repo" {
  for_each             = toset(["api", "web"])
  name                 = "${var.name}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "AES256" }
}

resource "aws_ecr_lifecycle_policy" "repo" {
  for_each   = aws_ecr_repository.repo
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1, description = "Keep the last 30 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
      action       = { type = "expire" }
    }]
  })
}
