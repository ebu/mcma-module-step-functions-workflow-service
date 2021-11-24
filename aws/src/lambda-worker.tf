#################################
#  lambda worker
#################################

locals {
  lambda_name_worker = format("%.64s", replace("${var.prefix}-worker", "/[^a-zA-Z0-9_]+/", "-" ))
}

resource "aws_iam_role" "worker" {
  name = format("%.64s", replace("${var.prefix}-${var.aws_region}-worker", "/[^a-zA-Z0-9_]+/", "-" ))
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

resource "aws_iam_role_policy" "worker" {
  name = aws_iam_role.worker.name
  role = aws_iam_role.worker.id

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
        Sid      = "WriteToCloudWatchLogs"
        Effect   = "Allow"
        Action   = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        Resource = concat([
          "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:${var.log_group.name}:*",
          "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${local.lambda_name_worker}:*",
        ], var.enhanced_monitoring_enabled ? [
          "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda-insights:*"
        ] : [])
      },
      {
        Sid      = "ListAndDescribeDynamoDBTables",
        Effect   = "Allow",
        Action   = [
          "dynamodb:List*",
          "dynamodb:DescribeReservedCapacity*",
          "dynamodb:DescribeLimits",
          "dynamodb:DescribeTimeToLive"
        ],
        Resource = "*"
      },
      {
        Sid      = "SpecificTable",
        Effect   = "Allow",
        Action   = [
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
        Sid      = "AllowInvokingApiGateway"
        Effect   = "Allow",
        Action   = "execute-api:Invoke",
        Resource = [
          "${var.service_registry.aws_apigatewayv2_stage.service_api.execution_arn}/*/*",
          "${var.job_processor.aws_apigatewayv2_stage.service_api.execution_arn}/*/*",
        ]
      },
      {
        Sid      = "AllowEnablingDisabling"
        Effect   = "Allow",
        Action   = ["events:EnableRule", "events:DisableRule"],
        Resource = aws_cloudwatch_event_rule.periodic_execution_checker.arn
      },
    ],
    length(var.workflows) > 0 ?
    [
      {
        Sid      = "AllowStepFunctions"
        Effect   = "Allow"
        Action   = [
          "states:DescribeStateMachine",
          "states:StartExecution",
          "states:ListExecutions"
        ]
        Resource = [for w in var.workflows : w.state_machine_arn]
      },
      {
        Sid      = "AllowStepFunctionsExecutions"
        Effect   = "Allow"
        Action   = [
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
        Sid      = "AllowManagingActivities"
        Effect   = "Allow"
        Action   = [
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
        Sid      = "AllowLambdaWritingToXRay"
        Effect   = "Allow",
        Action   = [
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
    ] : [])
  })
}

resource "aws_lambda_function" "worker" {
  depends_on = [
    aws_iam_role_policy.worker
  ]

  filename         = "${path.module}/lambdas/worker.zip"
  function_name    = local.lambda_name_worker
  role             = aws_iam_role.worker.arn
  handler          = "index.handler"
  source_code_hash = filebase64sha256("${path.module}/lambdas/worker.zip")
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
      CloudWatchEventRule = aws_cloudwatch_event_rule.periodic_execution_checker.name,
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