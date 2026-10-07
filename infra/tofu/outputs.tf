# Sensitive outputs only. Read one with: tofu output -raw <name>
# Place each on the VPS (Ansible reads them from your shell) and in the scoped GitHub
# environment; never paste one into the repo, a commit, or a PR.

output "r2_endpoint" {
  description = "S3 endpoint of the EU R2 jurisdiction."
  value       = "https://${var.cloudflare_account_id}.eu.r2.cloudflarestorage.com"
  sensitive   = true
}

output "r2_access_key_ids" {
  description = "Per-bucket S3 access key ids (the token ids)."
  value       = { for key, token in cloudflare_api_token.bucket : key => token.id }
  sensitive   = true
}

output "r2_secret_access_keys" {
  description = "Per-bucket S3 secret keys (SHA-256 of each token value)."
  value       = { for key, token in cloudflare_api_token.bucket : key => sha256(token.value) }
  sensitive   = true
}

output "test_cell_heartbeat_url" {
  description = "Ping URL for the test cell's heartbeat routine."
  value       = betteruptime_heartbeat.cell["test"].url
  sensitive   = true
}

output "heartbeat_urls" {
  description = "Ping URL per cell (test, owner, second, household) for SECBOT_HEARTBEAT_URLS and SECBOT_PROD_HEARTBEAT_URLS."
  value       = { for cell, heartbeat in betteruptime_heartbeat.cell : cell => heartbeat.url }
  sensitive   = true
}
