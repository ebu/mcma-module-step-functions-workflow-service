######################
# aws_dynamodb_table
######################

resource "aws_dynamodb_table" "service_table" {
  name         = var.prefix
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "resource_pkey"
  range_key    = "resource_skey"

  attribute {
    name = "resource_pkey"
    type = "S"
  }

  attribute {
    name = "resource_skey"
    type = "S"
  }

  tags = var.tags
}

resource "random_uuid" "workflows" {
  for_each = {for wf in var.workflows: wf.name => wf}
}

resource "aws_dynamodb_table_item" "workflows" {
  for_each = {for wf in var.workflows: wf.name => wf}

  table_name = aws_dynamodb_table.service_table.name
  hash_key   = aws_dynamodb_table.service_table.hash_key
  range_key  = aws_dynamodb_table.service_table.range_key

  item = jsonencode({
    resource_pkey: {
      S: "/workflows"
    }
    resource_skey: {
      S: random_uuid.workflows[each.key].result
    }
    resource: {
      M: {
        "@type": {
          "S": "StepFunctionsWorkflow"
        }
        id: {
          "S": "${local.service_url}/workflows/${random_uuid.workflows[each.key].result}"
        }
        name: {
          "S": each.key
        }
        stateMachineArn: {
          "S": each.value.state_machine_arn
        }
      }
    }
  })
}
