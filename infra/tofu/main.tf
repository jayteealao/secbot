locals {
  # One bucket per celld instance: celld deploys one application per fleet bucket.
  buckets = {
    test = "secbot-test"
    prod = "secbot-prod"
  }
}

# --- Cloudflare R2: the cells' durable store and off-provider replica (EU jurisdiction) ---

resource "cloudflare_r2_bucket" "cells" {
  for_each     = local.buckets
  account_id   = var.cloudflare_account_id
  name         = each.value
  jurisdiction = "eu"
}

data "cloudflare_account_api_token_permission_groups_list" "r2_write" {
  account_id = var.cloudflare_account_id
  name       = "Workers%20R2%20Storage%20Bucket%20Item%20Write"
}

# One token per bucket, scoped to that bucket's objects. celld uses it as S3 credentials:
# access key id = token id, secret access key = SHA-256 of the token value.
resource "cloudflare_api_token" "bucket" {
  for_each = local.buckets
  name     = "${each.value}-celld"
  policies = [{
    effect            = "allow"
    permission_groups = [{ id = data.cloudflare_account_api_token_permission_groups_list.r2_write.result[0].id }]
    resources = jsonencode({
      "com.cloudflare.edge.r2.bucket.${var.cloudflare_account_id}_eu_${each.value}" = "*"
    })
  }]
}

# --- Tailscale: who reaches what on the private network ---
# ci-test reaches only SSH on the VPS (the forced command limits it further); ci-prod the same
# for the production user; owner devices reach SSH and the celld worker port. Nothing reaches
# the celld internal port, which listens on loopback only.

resource "tailscale_acl" "secbot" {
  overwrite_existing_content = true
  acl = jsonencode({
    tagOwners = {
      "tag:secbot-vps"   = [var.owner_login]
      "tag:ci-test"      = [var.owner_login]
      "tag:ci-prod"      = [var.owner_login]
      "tag:owner-device" = [var.owner_login]
    }
    acls = [
      { action = "accept", src = ["tag:ci-test", "tag:ci-prod"], dst = ["tag:secbot-vps:22"] },
      { action = "accept", src = ["tag:owner-device"], dst = ["tag:secbot-vps:22", "tag:secbot-vps:${var.worker_port}"] },
      { action = "accept", src = ["tag:secbot-vps"], dst = ["tag:secbot-vps:${var.worker_port}"] },
    ]
    ssh = []
  })
}

# --- Better Stack: the test cell's heartbeat (one per cell; the others come with production) ---

resource "betteruptime_heartbeat" "test_cell" {
  name   = "secbot test cell"
  period = 300
  grace  = 60
  email  = true
  push   = true
}
