resource "mcma_service" "service" {
  depends_on = [
    aws_apigatewayv2_api.service_api,
    aws_apigatewayv2_integration.service_api,
    aws_apigatewayv2_route.service_api_default,
    aws_apigatewayv2_route.service_api_options,
    aws_apigatewayv2_stage.service_api,
    aws_dynamodb_table.service_table,
    aws_iam_role.api_handler,
    aws_iam_role_policy.api_handler,
    aws_lambda_function.api_handler,
    aws_lambda_permission.service_api_default,
    aws_lambda_permission.service_api_options,
  ]

  name      = var.name
  auth_type = local.service_auth_type
  job_type  = "WorkflowJob"

  resource {
    resource_type = "JobAssignment"
    http_endpoint = "${local.service_url}/job-assignments"
  }

  job_profile_ids = [ for jp in mcma_job_profile.job_profiles : jp.id ]
}

resource "mcma_job_profile" "job_profiles" {
  for_each = {for wf in var.workflows : wf.name => wf}

  name = each.value.name

  dynamic input_parameter {
    for_each = each.value.input_parameters
    content {
      name = input_parameter.value.parameter_name
      type = input_parameter.value.parameter_type
    }
  }

  dynamic input_parameter {
    for_each = each.value.optional_input_parameters
    content {
      name = input_parameter.value.parameter_name
      type = input_parameter.value.parameter_type
      optional = true
    }
  }

  dynamic output_parameter {
    for_each = each.value.output_parameters
    content {
      name = output_parameter.value.parameter_name
      type = output_parameter.value.parameter_type
    }
  }
}
