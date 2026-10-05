# Runbook: apple-signing

## When this fires

CI logs that match any of these patterns (case-insensitive) trigger this runbook:

- `(certificate|provisioning profile).*(expired|invalid|not found)`
- `App Store Connect.*(401|403|unauthorized)`
- `altool|notarytool|pilot.*error`

## Steps

1. Check the expiry of the iOS distribution certificate and the App Store Connect API key.
2. Renew the expired item in the Apple developer account.
3. Replace the matching secret in the production environment.
4. Rerun the app release workflow for the same app tag.

## Notes

_Seeded from ship plan `recovery-playbooks[apple-signing]`. Update this file as the playbook evolves._
_Last synced from plan version: 1_
