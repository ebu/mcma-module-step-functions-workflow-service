#########################
# Environment Variables
#########################

variable "name" {
  type        = string
  description = "Optional variable to set a custom name for this service in the service registry"
  default     = "StepFunctions Workflow Service"
}

variable "prefix" {
  type        = string
  description = "Prefix for all managed resources in this module"
}

variable "stage_name" {
  type        = string
  description = "Stage name to be used for the API Gateway deployment"
}

variable "tags" {
  type        = map(string)
  description = "Tags applied to created resources"
  default     = {}
}

variable "dead_letter_config_target" {
  type        = string
  description = "Configuring dead letter target for worker lambda"
  default     = null
}

#########################
# State machines
#########################

variable "workflows" {
  type = list(object({
    name             = string
    input_parameters = list(object({
      parameter_name = string
      parameter_type = string
    }))
    optional_input_parameters = list(object({
      parameter_name = string
      parameter_type = string
    }))
    output_parameters = list(object({
      parameter_name = string
      parameter_type = string
    }))
    state_machine_arn = string
    activity_arns     = list(string)
  }))
  description = "list of workflows that the step function service can execute"
}

locals {
  activity_arns = flatten([for w in var.workflows : [for a in coalesce(w.activity_arns, []) : a]])
}

#########################
# AWS Variables
#########################

variable "aws_region" {
  type        = string
  description = "AWS Region to which this module is deployed"
}

variable "iam_role_path" {
  type        = string
  description = "Path for creation of access role"
  default     = "/"
}

variable "iam_permissions_boundary" {
  type        = string
  description = "IAM permissions boundary"
  default     = null
}

#########################
# Dependencies
#########################

variable "service_registry" {
  type = object({
    auth_type   = string
    service_url = string
  })
}

variable "execute_api_arns" {
  type        = list(string)
  description = "Optional list of api gateway execution arns that will allow you to control which APIs the lambdas are allowed to invoke"
  default     = ["arn:aws:execute-api:*:*:*"]
}

#########################
# Logging
#########################

variable "log_group" {
  type = object({
    id   = string
    arn  = string
    name = string
  })
  description = "Log group used by MCMA Event tracking"
}

variable "api_gateway_metrics_enabled" {
  type        = bool
  description = "Enable API Gateway metrics"
  default     = false
}

variable "xray_tracing_enabled" {
  type        = bool
  description = "Enable X-Ray tracing"
  default     = false
}

variable "enhanced_monitoring_enabled" {
  type        = bool
  description = "Enable CloudWatch Lambda Insights"
  default     = false
}
