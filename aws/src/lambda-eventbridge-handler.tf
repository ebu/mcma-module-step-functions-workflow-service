#################################
#  lambda eventbridge_handler
#################################

locals {
  lambda_name_eventbridge_handler = format("%.64s", replace("${var.prefix}-eventbridge-handler", "/[^a-zA-Z0-9_]+/", "-" ))
}

resource "aws_iam_role" "eventbridge_handler" {
  name = format("%.64s", replace("${var.prefix}-${var.aws_region}-eventbridge-handler", "/[^a-zA-Z0-9_]+/", "-" ))
  path = var.iam_role_path

  assume_role_policy = jsonencode({
    Version   = "2012-10-17",
    Statement = [
      {
        Sid       = "AllowLambdaAssumingRole"
        Effect    = "Allow"
        Action    = "sts:AssumeRole",
        Principal = {
          "Service" = "lambda.amazonaws.com"
        }
      }
    ]
  })

  tags = var.tags
}

resource "aws_iam_role_policy" "eventbridge_handler" {
  name = aws_iam_role.eventbridge_handler.name
  role = aws_iam_role.eventbridge_handler.id

  policy = jsonencode({
    Version   = "2012-10-17",
    Statement = concat([
      {
        Sid      = "DescribeCloudWatchLogs"
        Effect   = "Allow"
        Action   = "logs:DescribeLogGroups"
        Resource = "*"
      },
      {
        Sid    = "WriteToCloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        Resource = concat([
          "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:${var.log_group.name}:*",
          "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${local.lambda_name_eventbridge_handler}:*",
        ], var.enhanced_monitoring_enabled ? [
          "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda-insights:*"
        ] : [])
      },
      {
        Sid    = "ListAndDescribeDynamoDBTables",
        Effect = "Allow",
        Action = [
          "dynamodb:List*",
          "dynamodb:DescribeReservedCapacity*",
          "dynamodb:DescribeLimits",
          "dynamodb:DescribeTimeToLive"
        ],
        Resource = "*"
      },
      {
        Sid    = "SpecificTable",
        Effect = "Allow",
        Action = [
          "dynamodb:BatchGet*",
          "dynamodb:DescribeStream",
          "dynamodb:DescribeTable",
          "dynamodb:Get*",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:BatchWrite*",
          "dynamodb:CreateTable",
          "dynamodb:Delete*",
          "dynamodb:Update*",
          "dynamodb:PutItem"
        ],
        Resource = [
          aws_dynamodb_table.service_table.arn
        ]
      },
      {
        Sid      = "AllowEnablingDisabling"
        Effect   = "Allow",
        Action   = [
          "events:DescribeRule",
          "events:EnableRule",
          "events:DisableRule",
        ],
        Resource = aws_cloudwatch_event_rule.eventbridge_handler_stepfunctions.arn
      },
    ],
      length(var.workflows) > 0 ?
      [
        {
          Sid    = "AllowStepFunctions"
          Effect = "Allow"
          Action = [
            "states:DescribeStateMachine",
            "states:StartExecution",
            "states:ListExecutions"
          ]
          Resource = [for w in var.workflows : w.state_machine_arn]
        },
        {
          Sid    = "AllowStepFunctionsExecutions"
          Effect = "Allow"
          Action = [
            "states:DescribeExecution",
            "states:DescribeStateMachineForExecution",
            "states:GetExecutionHistory",
            "states:StopExecution",
          ]
          Resource = [for w in var.workflows : replace("${w.state_machine_arn}:*", "stateMachine", "execution")]
        },
      ] : [],
      length(local.activity_arns) > 0 ?
      [
        {
          Sid    = "AllowManagingActivities"
          Effect = "Allow"
          Action = [
            "states:DescribeActivity",
            "states:SendTaskSuccess",
            "states:SendTaskFailure",
          ]
          Resource = local.activity_arns
        }
      ] : [],
      var.xray_tracing_enabled ?
      [
        {
          Sid    = "AllowLambdaWritingToXRay"
          Effect = "Allow",
          Action = [
            "xray:PutTraceSegments",
            "xray:PutTelemetryRecords",
            "xray:GetSamplingRules",
            "xray:GetSamplingTargets",
            "xray:GetSamplingStatisticSummaries",
          ],
          Resource = "*"
        }
      ] : [],
      var.dead_letter_config_target != null ?
      [
        {
          Effect : "Allow",
          Action : "sqs:SendMessage",
          Resource : var.dead_letter_config_target
        }
      ] : [],
      length(var.execute_api_arns) > 0 ?
      [
        {
          Sid      = "AllowInvokingApiGateway"
          Effect   = "Allow"
          Action   = "execute-api:Invoke"
          Resource = var.execute_api_arns
        },
      ] : [])
  })
}

resource "aws_lambda_function" "eventbridge_handler" {
  depends_on = [
    aws_iam_role_policy.eventbridge_handler
  ]

  filename         = "${path.module}/lambdas/eventbridge-handler.zip"
  function_name    = local.lambda_name_eventbridge_handler
  role             = aws_iam_role.eventbridge_handler.arn
  handler          = "index.handler"
  source_code_hash = filebase64sha256("${path.module}/lambdas/eventbridge-handler.zip")
  runtime          = "nodejs14.x"
  timeout          = "900"
  memory_size      = "2048"

  layers = var.enhanced_monitoring_enabled ? ["arn:aws:lambda:${var.aws_region}:580247275435:layer:LambdaInsightsExtension:14"] : []

  environment {
    variables = {
      LogGroupName        = var.log_group.name
      TableName           = aws_dynamodb_table.service_table.name
      PublicUrl           = local.service_url
      ServicesUrl         = var.service_registry.services_url
      ServicesAuthType    = var.service_registry.auth_type
      CloudWatchEventRule = aws_cloudwatch_event_rule.eventbridge_handler_stepfunctions.name,
    }
  }

  dynamic "dead_letter_config" {
    for_each = var.dead_letter_config_target != null ? toset([1]) : toset([])

    content {
      target_arn = var.dead_letter_config_target
    }
  }

  tracing_config {
    mode = var.xray_tracing_enabled ? "Active" : "PassThrough"
  }

  tags = var.tags
}

resource "aws_cloudwatch_event_rule" "eventbridge_handler_periodic" {
  name                = format("%.64s", "${var.prefix}-eventbridge-handler")
  schedule_expression = "cron(0/1 * * * ? *)"
  is_enabled          = false

  lifecycle {
    ignore_changes = [is_enabled]
  }

  tags = var.tags
}

resource "aws_lambda_permission" "eventbridge_handler_periodic" {
  statement_id  = "AllowEventBridgePeriodic"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.eventbridge_handler.arn
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.eventbridge_handler_periodic.arn
}

resource "aws_cloudwatch_event_target" "eventbridge_handler_periodic" {
  arn  = aws_lambda_function.eventbridge_handler.arn
  rule = aws_cloudwatch_event_rule.eventbridge_handler_periodic.name
}

resource "aws_cloudwatch_event_rule" "eventbridge_handler_stepfunctions" {
  name          = var.prefix
  event_pattern = jsonencode({
    source      = ["aws.states"]
    detail-type = ["Step Functions Execution Status Change"]
    detail      = {
      stateMachineArn = [for w in var.workflows : w.state_machine_arn]
    }
  })

  tags = var.tags
}

resource "aws_lambda_permission" "eventbridge_handler_stepfunctions" {
  statement_id  = "AllowEventBridgeStepfunctions"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.eventbridge_handler.arn
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.eventbridge_handler_stepfunctions.arn
}

resource "aws_cloudwatch_event_target" "eventbridge_handler_stepfunctions" {
  arn  = aws_lambda_function.eventbridge_handler.arn
  rule = aws_cloudwatch_event_rule.eventbridge_handler_stepfunctions.name
}
