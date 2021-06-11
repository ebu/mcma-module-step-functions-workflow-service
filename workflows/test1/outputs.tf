output "workflow_definition" {
  value = {
    name                      = var.name
    input_parameters          = [
      {
        parameter_name: "inputFile"
        parameter_type: "AwsS3FileLocator"
      }
    ]
    optional_input_parameters = []
    output_parameters         = [
      {
        parameter_name: "outputFile"
        parameter_type: "AwsS3FileLocator"
      }]
    state_machine_arn         = local.state_machine_arn
    activity_arns             = [aws_sfn_activity.step2.id]
  }
}
