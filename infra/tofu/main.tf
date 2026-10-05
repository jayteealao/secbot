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

# User-scope list (/user/tokens/permission_groups): the bucket tokens below are user tokens, so the
# "API Tokens Edit" user permission covers both this read and the token creation.
data "cloudflare_api_token_permission_groups_list" "r2_write" {
  name = "Workers%20R2%20Storage%20Bucket%20Item%20Write"
}

# One token per bucket, scoped to that bucket's objects. celld uses it as S3 credentials:
# access key id = token id, secret access key = SHA-256 of the token value.
resource "cloudflare_api_token" "bucket" {
  for_each = local.buckets
  name     = "${each.value}-celld"
  policies = [{
    effect            = "allow"
    permission_groups = [{ id = data.cloudflare_api_token_permission_groups_list.r2_write.result[0].id }]
    resources = jsonencode({
      "com.cloudflare.edge.r2.bucket.${var.cloudflare_account_id}_eu_${each.value}" = "*"
    })
  }]
}

# --- Tailscale: not managed here ---
# The tailscale_acl resource owns the whole tailnet policy and would replace the owner's
# existing rules. The owner adds the Secbot rules by hand: docs/runbooks/tailnet-access.md.

# --- Better Stack: the test cell's heartbeat (one per cell; the others come with production) ---

resource "betteruptime_heartbeat" "test_cell" {
  name   = "secbot test cell"
  period = 300
  grace  = 60
  email  = true
  push   = true
}
