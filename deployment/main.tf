#########################
# Provider registration
#########################

provider "aws" {
  profile = var.aws_profile
  region  = var.aws_region
}

provider "mcma" {
  service_registry_url = module.service_registry.service_url

  aws4_auth {
    profile = var.aws_profile
    region  = var.aws_region
  }
}

############################################
# Cloud watch log group for central logging
############################################

resource "aws_cloudwatch_log_group" "main" {
  name = "/mcma/${var.global_prefix}"
}

#########################
# Service Registry Module
#########################

module "service_registry" {
  source = "github.com/ebu/mcma-module-service-registry//aws/module?ref=v1.0.0"

  prefix = "${var.global_prefix}-service-registry"

  api_security_auth_type = "AWS4"

  aws_region = var.aws_region
  stage_name = var.environment_type

  log_group                   = aws_cloudwatch_log_group.main
  api_gateway_metrics_enabled = true
  xray_tracing_enabled        = true
  enhanced_monitoring_enabled = true
}

#########################
# Job Processor Module
#########################

module "job_processor" {
  source = "github.com/ebu/mcma-module-job-processor//aws/module?ref=v1.0.0"

  prefix = "${var.global_prefix}-job-processor"

  api_security_auth_type = "AWS4"

  aws_region     = var.aws_region
  stage_name     = var.environment_type
  dashboard_name = var.global_prefix

  service_registry = module.service_registry
  execute_api_arns = [
    "${module.service_registry.aws_apigatewayv2_stage.service_api.execution_arn}/*/*",
    "${module.mediainfo_ame_service.aws_apigatewayv2_stage.service_api.execution_arn}/*/*",
    "${module.stepfunctions_workflow_service.aws_apigatewayv2_stage.service_api.execution_arn}/*/*",
  ]

  log_group                   = aws_cloudwatch_log_group.main
  api_gateway_metrics_enabled = true
  xray_tracing_enabled        = true
  enhanced_monitoring_enabled = true
}

#########################
# Media Info AME Service
#########################

module "mediainfo_ame_service" {
  source = "github.com/ebu/mcma-module-mediainfo-ame-service//aws/module?ref=v1.0.0"

  prefix = "${var.global_prefix}-mediainfo-ame-service"

  stage_name = var.environment_type
  aws_region = var.aws_region

  service_registry = module.service_registry

  log_group                   = aws_cloudwatch_log_group.main
  api_gateway_metrics_enabled = true
  xray_tracing_enabled        = true
  enhanced_monitoring_enabled = true
}

########################################
# AWS Step Functions Workflow Service
########################################

module "stepfunctions_workflow_service" {
  source = "../aws/module"

  prefix = "${var.global_prefix}-sf-workflow-service"

  stage_name               = var.environment_type
  aws_region               = var.aws_region
  iam_permissions_boundary = var.aws_iam_permissions_boundary

  service_registry = module.service_registry

  log_group                   = aws_cloudwatch_log_group.main
  api_gateway_metrics_enabled = true
  xray_tracing_enabled        = true

  workflows = [module.test_workflow_1.workflow_definition]
}

########################################
# Test Workflow
########################################

module "test_workflow_1" {
  source = "../workflows/test1"

  prefix = "${var.global_prefix}-test-workflow-1"

  aws_region               = var.aws_region
  iam_permissions_boundary = var.aws_iam_permissions_boundary

  service_registry = module.service_registry

  log_group = aws_cloudwatch_log_group.main
}

########################################
# Bucket for testing
########################################
resource "aws_s3_bucket" "upload" {
  bucket = "${var.global_prefix}-upload-${var.aws_region}"

  lifecycle {
    ignore_changes = [
      lifecycle_rule
    ]
  }

  force_destroy = true
}

resource "aws_s3_bucket_lifecycle_configuration" "upload" {
  bucket = aws_s3_bucket.upload.id

  rule {
    id     = "Delete after 1 day"
    status = "Enabled"
    expiration {
      days = 1
    }
  }
}

resource "aws_s3_bucket_public_access_block" "upload" {
  bucket = aws_s3_bucket.upload.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
