# Runbook: tailnet-access

## When to use this runbook

Use this runbook once, before the first release that deploys to the VPS. Use it again when a
release job fails at the "Join the private network" step or at the first SSH to the VPS.

The owner's tailnet policy is not managed by OpenTofu. The `tailscale_acl` resource owns the whole
policy file and replaces every rule in it, so the owner adds the Secbot rules by hand. The VPS
address and the OAuth secrets never enter this repo; they live in the Tailscale admin console and
in the GitHub environments.

## What the release jobs need

A release job joins the tailnet as a short-lived device with a tag, then opens SSH to the VPS. The
forced command on the VPS limits what that SSH key can run.

| Tag | Used by | GitHub environments | Secrets |
|---|---|---|---|
| `tag:ci-test` | test-cell stage, deploy, and conformance | `test-cell` | `PRIVATE_NET_TEST_OAUTH_CLIENT_ID`, `PRIVATE_NET_TEST_OAUTH_SECRET` |
| `tag:ci-prod` | production deploy, rollout, rollback, restore | `production`, `production-rollout` | `PRIVATE_NET_PROD_OAUTH_CLIENT_ID`, `PRIVATE_NET_PROD_OAUTH_SECRET` |

## Steps

Do these steps in the Tailscale admin console.

1. On the Access controls page, add a hosts entry for the VPS. Put the VPS tailnet address in the
   value. The rule in step 3 then targets the VPS without retagging it.

   ```json
   "hosts": { "secbot-vps": "<VPS tailnet address>" }
   ```

2. Add the two tag owners. Only an admin, or an OAuth client that an admin creates, can apply them.

   ```json
   "tagOwners": {
     "tag:ci-test": ["autogroup:admin"],
     "tag:ci-prod": ["autogroup:admin"]
   }
   ```

3. Add one rule to the `acls` list. It lets a release runner reach SSH on the VPS and nothing else.

   ```json
   { "action": "accept", "src": ["tag:ci-test", "tag:ci-prod"], "dst": ["secbot-vps:22"] }
   ```

4. If the policy has the default allow-all rule (`"src": ["*"]`), change its source to
   `autogroup:member`. The device must then belong to a tailnet member to match the rule. Tagged
   CI runners are not members, so they reach only the VPS SSH port.

   ```json
   { "action": "accept", "src": ["autogroup:member"], "dst": ["*:*"] }
   ```

   Before you save, check that every device you use is logged in as a member. A device that is
   tagged, or that runs under another login, loses the access that the allow-all rule gave it.

5. Save the policy. The policy must save with no error. If Tailscale reports an unknown tag or an
   unknown host, add the missing entry from step 1 or step 2.

6. On the Settings → OAuth clients page, create the test client. Give it the `Auth Keys` write
   scope and only the tag `tag:ci-test`.

7. In the GitHub environment `test-cell`, add the test client's ID as
   `PRIVATE_NET_TEST_OAUTH_CLIENT_ID` and its secret as `PRIVATE_NET_TEST_OAUTH_SECRET`.

8. On the Settings → OAuth clients page, create the production client. Give it the `Auth Keys`
   write scope and only the tag `tag:ci-prod`.

9. In the GitHub environments `production` and `production-rollout`, add the production client's
   ID as `PRIVATE_NET_PROD_OAUTH_CLIENT_ID` and its secret as `PRIVATE_NET_PROD_OAUTH_SECRET`.

## Check

1. Run a release to the test cell. The "Join the private network" step must pass, and the next
   SSH step must reach the VPS.
2. On the Machines page, find the runner during the job. It must show the tag `tag:ci-test` and
   must disappear after the job ends.
