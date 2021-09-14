##################################
# aws_iam_role + aws_iam_policy
##################################

resource "aws_iam_role" "lambda_execution" {
  name               = format("%.64s", "${var.prefix}.${var.aws_region}.lambda-execution")
  path               = var.iam_role_path
  assume_role_policy = jsonencode({
    Version   : "2012-10-17",
    Statement : [
      {
        Sid       : "AllowLambdaAssumingRole"
        Effect    : "Allow"
        Action    : "sts:AssumeRole",
        Principal : {
          "Service" : "lambda.amazonaws.com"
        }
      }
    ]
  })

  tags = var.tags
}

resource "aws_iam_policy" "lambda_execution" {
  name   = format("%.128s", "${var.prefix}.${var.aws_region}.lambda-execution")
  path   = var.iam_policy_path
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = concat([
      {
        Sid      : "AllowLambdaWritingToLogs"
        Effect   : "Allow"
        Action   : "logs:*"
        Resource : "*"
      },
      {
        Sid      : "AllowInvokingApiGateway"
        Effect   : "Allow"
        Action   : "execute-api:Invoke"
        Resource : "arn:aws:execute-api:*:*:*"
      },
      {
        Sid      : "AllowGettingActivityTask"
        Effect   : "Allow"
        Action   : "states:GetActivityTask"
        Resource : [
          aws_sfn_activity.step2.id,
        ]
      }
    ],
    var.xray_tracing_enabled ?
    [{
      Sid      : "AllowLambdaWritingToXRay"
      Effect   : "Allow",
      Action   : [
        "xray:PutTraceSegments",
        "xray:PutTelemetryRecords",
      ],
      Resource : "*"
    }]: [])
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "lambda_execution" {
  role       = aws_iam_role.lambda_execution.id
  policy_arn = aws_iam_policy.lambda_execution.arn
}

#################################
#  aws_iam_role : stepfunctions_execution
#################################

resource "aws_iam_role" "stepfunctions_execution" {
  name               = format("%.64s", "${var.prefix}.${var.aws_region}.step-functions-execution")
  assume_role_policy = jsonencode({
    Version: "2012-10-17"
    Statement: [
      {
        Action: "sts:AssumeRole"
        Principal: {
          Service: "states.${var.aws_region}.amazonaws.com"
        },
        Effect: "Allow"
      }
    ]
  })

  tags = var.tags
}

resource "aws_iam_role_policy" "stepfunctions_execution" {
  name   = format("%.128s", "${var.prefix}.${var.aws_region}.step-functions-execution")
  role   = aws_iam_role.stepfunctions_execution.id
  policy = jsonencode({
    Version: "2012-10-17"
    Statement: [
      {
        Effect: "Allow"
        Action: "lambda:InvokeFunction"
        Resource: [
          aws_lambda_function.step1.arn,
          aws_lambda_function.step2.arn,
          aws_lambda_function.step3.arn,
        ]
      }
    ]
  })
}


#################################
#  Step Functions : Lambdas for workflow
#################################

resource "aws_lambda_function" step1 {
  filename         = "${path.module}/step1/build/dist/lambda.zip"
  function_name    = format("%.64s", "${var.prefix}-step1")
  role             = aws_iam_role.lambda_execution.arn
  handler          = "index.handler"
  source_code_hash = filebase64sha256("${path.module}/step1/build/dist/lambda.zip")
  runtime          = "nodejs14.x"
  timeout          = "900"
  memory_size      = "3008"

  layers = var.enhanced_monitoring_enabled ? ["arn:aws:lambda:${var.aws_region}:580247275435:layer:LambdaInsightsExtension:14"] : []

  environment {
    variables = {
      LogGroupName     = var.log_group.name
      ServicesUrl      = var.service_registry.services_url
      ServicesAuthType = var.service_registry.auth_type
    }
  }

  tags = var.tags
}

resource "aws_lambda_function" step2 {
  filename         = "${path.module}/step2/build/dist/lambda.zip"
  function_name    = format("%.64s", "${var.prefix}-step2")
  role             = aws_iam_role.lambda_execution.arn
  handler          = "index.handler"
  source_code_hash = filebase64sha256("${path.module}/step2/build/dist/lambda.zip")
  runtime          = "nodejs14.x"
  timeout          = "900"
  memory_size      = "3008"

  layers = var.enhanced_monitoring_enabled ? ["arn:aws:lambda:${var.aws_region}:580247275435:layer:LambdaInsightsExtension:14"] : []

  environment {
    variables = {
      LogGroupName     = var.log_group.name
      ServicesUrl      = var.service_registry.services_url
      ServicesAuthType = var.service_registry.auth_type
      ActivityArn      = aws_sfn_activity.step2.id
    }
  }

  tags = var.tags
}

resource "aws_sfn_activity" "step2" {
  name = "${var.prefix}-step2"

  tags = var.tags
}

resource "aws_lambda_function" step3 {
  filename         = "${path.module}/step3/build/dist/lambda.zip"
  function_name    = format("%.64s", "${var.prefix}-step3")
  role             = aws_iam_role.lambda_execution.arn
  handler          = "index.handler"
  source_code_hash = filebase64sha256("${path.module}/step3/build/dist/lambda.zip")
  runtime          = "nodejs14.x"
  timeout          = "900"
  memory_size      = "3008"

  layers = var.enhanced_monitoring_enabled ? ["arn:aws:lambda:${var.aws_region}:580247275435:layer:LambdaInsightsExtension:14"] : []

  environment {
    variables = {
      LogGroupName     = var.log_group.name
      ServicesUrl      = var.service_registry.services_url
      ServicesAuthType = var.service_registry.auth_type
    }
  }

  tags = var.tags
}

#################################
#  Step Functions : Workflow
#################################

resource "aws_sfn_state_machine" "workflow" {
  name       = var.prefix
  role_arn   = aws_iam_role.stepfunctions_execution.arn
  definition = jsonencode({
    Comment: "Test Workflow"
    StartAt: "Step1"
    States: {
      Step1: {
        Type: "Task"
        Resource: aws_lambda_function.step1.arn
        ResultPath: "$.data.test"
        Next: "Step2"
      },
      Step2: {
        Type: "Parallel"
        Branches: [
          {
            StartAt: "Step2-start-job"
            States: {
              Step2-start-job: {
                Type: "Task"
                Resource: aws_lambda_function.step2.arn
                ResultPath: "$.data.jobId"
                End: true
              }
            }
          },
          {
            StartAt: "Step2-wait-for-job-completion"
            States: {
              Step2-wait-for-job-completion: {
                Type: "Task"
                Resource: aws_sfn_activity.step2.id
                TimeoutSeconds: 3600
                End: true
              }
            }
          }
        ]
        OutputPath: "$[0]"
        Next: "Step3"
      }
      Step3: {
        Type: "Task"
        Resource: aws_lambda_function.step3.arn
        ResultPath: "$.output"
        End: true
      }
    }
  })

  tags = var.tags
}

locals {
  ## local variable to avoid cyclic dependency
  state_machine_arn = "arn:aws:states:${var.aws_region}:${var.aws_account_id}:stateMachine:${var.prefix}"
}
