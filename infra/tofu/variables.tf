# Every identifier is a variable with no default, set as TF_VAR_<name> in the owner's shell.

variable "state_passphrase" {
  description = "Passphrase that encrypts the local state and plan files (at least 16 characters)."
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account that owns the R2 buckets."
  type        = string
  sensitive   = true
}

variable "tailnet" {
  description = "Tailscale tailnet name."
  type        = string
  sensitive   = true
}

variable "owner_login" {
  description = "Tailscale login of the owner, who may tag owner devices."
  type        = string
  sensitive   = true
}

variable "worker_port" {
  description = "celld worker listener port on the VPS private-network address."
  type        = number
  default     = 8787
}
