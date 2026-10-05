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

