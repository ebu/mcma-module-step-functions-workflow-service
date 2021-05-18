
output "service_registry" {
  value = {
    auth_type: module.service_registry.auth_type
    services_url: module.service_registry.services_url
  }
}
