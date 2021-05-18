output "workflow_definition" {
  value = {
    name                      = var.name
    input_parameters          = []
    optional_input_parameters = []
    output_parameters         = []
    state_machine_arn         = local.state_machine_arn
  }
}
