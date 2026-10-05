# Providers pinned to the versions read from the OpenTofu registry on 2026-10-05.
# State stays local (gitignored) and encrypted with a passphrase from TF_VAR_state_passphrase:
# it holds account ids and the heartbeat URL, which never enter the repo.
terraform {
  required_version = ">= 1.7.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.27"
    }
    tailscale = {
      source  = "tailscale/tailscale"
      version = "~> 0.29"
    }
    betteruptime = {
      source  = "BetterStackHQ/better-uptime"
      version = "~> 0.22"
    }
  }

  encryption {
    key_provider "pbkdf2" "owner" {
      passphrase = var.state_passphrase
    }
    method "aes_gcm" "owner" {
      keys = key_provider.pbkdf2.owner
    }
    state {
      method   = method.aes_gcm.owner
      enforced = true
    }
    plan {
      method   = method.aes_gcm.owner
      enforced = true
    }
  }
}

# Each provider reads its token from the environment: CLOUDFLARE_API_TOKEN,
# TAILSCALE_API_KEY (or OAuth client variables), BETTERUPTIME_API_TOKEN.
provider "cloudflare" {}

provider "tailscale" {
  tailnet = var.tailnet
}

provider "betteruptime" {}
