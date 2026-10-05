---
schema: sdlc/v1
type: ship-plan
slug: secbot
plan-version: 2
created-at: "2026-10-05T11:00:16Z"
updated-at: "2026-10-05T12:54:19Z"
project-name: "Secbot"
template-hint: none

# === Required core — read by /wf ship ===

# Block A — what ship means
ship-meaning: deploy-rolling
ship-environments:
  - name: "test-cell"
    auto-promote: true
    protection:
      required-reviewers: []
      wait-timer-minutes: 0
      deployment-branch-policy: custom   # tags v* and app-v* only
  - name: "production"
    auto-promote: false
    protection:
      required-reviewers: ["@jayteealao"]
      wait-timer-minutes: 0
      deployment-branch-policy: custom   # tags v* and app-v*; main for the rollback workflow
  - name: "production-rollout"         # later production stages; approval-binding ties them to the approval
    auto-promote: true
    protection:
      required-reviewers: []
      wait-timer-minutes: 0
      deployment-branch-policy: custom   # tags v* and app-v*; main for the rollback workflow
  - name: "release"                    # holds the release App key; not a deploy target
    auto-promote: false
    protection:
      required-reviewers: []
      wait-timer-minutes: 0
      deployment-branch-policy: custom   # main only
approval-binding:
  ledger: "VPS deploy ledger; the snapshot-cells job writes one record per approved run attempt"
  record: ["tag", "run-id", "run-attempt", "snapshot-id"]
  rule: "every production-rollout job refuses unless the ledger record matches its own tag, run id, and run attempt, and no newer deploy or rollback is recorded"
ship-cadence: on-demand

# Block B — versioning contract
version-scheme: semver
version-source-of-truth:
  - { path: "package.json", field: "version" }                       # server track, tag v<semver>
  - { path: "app/gradle.properties", field: "VERSION_NAME" }         # app track, tag app-v<semver>
  - { path: "app/gradle.properties", field: "VERSION_CODE" }         # app track, strictly increasing integer
  - { path: ".release-please-manifest.json", field: "<component>" }  # one entry per component: "." (server), "app"
version-bump-rule: release-please
version-bump-cmd: "npx release-please release-pr --repo-url=jayteealao/secbot --config-file=release-please-config.json --manifest-file=.release-please-manifest.json"
prerelease-suffix: none
post-release-version: none
post-release-version-cmd: ""

# Block C — CI/CD contract
ci-pipeline:
  pre-merge-checks:
    - biome
    - type-check
    - test-server
    - ktlint
    - detekt
    - app-build
    - commitlint
    - pr-title
    - codeql-javascript-typescript
    - codeql-java-kotlin
    - gitleaks
    - osv-scanner
    - license-check
  release-trigger: tag-on-main
  release-workflow-file: ".github/workflows/release-server.yml"
  release-jobs:
    - build                     # runs in test-cell; stages the bundle on the VPS release store
    - conformance
    - sbom
    - deploy-test-cell
    - verify-test-cell
    - snapshot-cells
    - deploy-owner-cell
    - verify-owner-cell
    - deploy-person-and-household-cells
    - verify-person-and-household-cells
    - deploy-secrets-cell
    - verify-all-cells
    - github-release            # SBOM, SHA-256 checksum, and build-provenance attestation only
  bundle-handling:
    public-artifacts: false     # the bundle holds private fork code; no workflow artifact or release asset carries it
    transport: "the build job stages the bundle on the VPS release store through the test-cell deploy path; later jobs refer to it by tag and SHA-256"
    release-store: "VPS, last 5 tags; the VPS mirrors each staged bundle to the off-provider bucket"
    public-evidence: ["SPDX SBOM", "SHA-256 checksum", "build-provenance attestation"]
  publish-dry-run-cmd: "mise run deploy:dry-run"
  publish-cmd: "mise run deploy -- --env production --version <tag>"
  required-secrets:
    # scope = where the secret lives. An environment secret reaches only the jobs that name that environment.
    - { name: "PRIVATE_NET_TEST_OAUTH_CLIENT_ID", scope: "env test-cell", purpose: "Joins a test-cell job to the private network as tag:ci-test, which reaches only the test-cell deploy path." }
    - { name: "PRIVATE_NET_TEST_OAUTH_SECRET", scope: "env test-cell", purpose: "Secret half of the tag:ci-test OAuth client." }
    - { name: "PRIVATE_NET_PROD_OAUTH_CLIENT_ID", scope: "env production, env production-rollout", purpose: "Joins a production job to the private network as tag:ci-prod." }
    - { name: "PRIVATE_NET_PROD_OAUTH_SECRET", scope: "env production, env production-rollout", purpose: "Secret half of the tag:ci-prod OAuth client." }
    - { name: "VPS_DEPLOY_HOST", scope: "env test-cell, env production, env production-rollout", purpose: "Private-network address of the VPS; kept out of the public repo." }
    - { name: "VPS_SSH_KNOWN_HOSTS", scope: "env test-cell, env production, env production-rollout", purpose: "Pinned host key of the VPS, so the runner refuses an impostor." }
    - { name: "TEST_CELL_DEPLOY_SSH_KEY", scope: "env test-cell", purpose: "SSH key of a separate VPS user whose forced command can only stage a bundle and deploy it to the test cell." }
    - { name: "VPS_DEPLOY_SSH_KEY", scope: "env production, env production-rollout", purpose: "SSH key of the production deploy user; it never exists in test-cell." }
    - { name: "HEARTBEAT_API_TOKEN", scope: "env test-cell, env production, env production-rollout", purpose: "Read-only access to the outside heartbeat service for the post-publish check." }
    - { name: "FORKS_READ_TOKEN", scope: "repository", purpose: "Fine-grained PAT: contents read on the two private fork repos only, 30-day expiry. Only the install step receives it, through GIT_CONFIG_* env; never ~/.gitconfig." }
    - { name: "RELEASE_APP_CLIENT_ID", scope: "env release", purpose: "Client id of the release GitHub App; release-please opens release PRs and creates tags as this App." }
    - { name: "RELEASE_APP_PRIVATE_KEY", scope: "env release", purpose: "Private key of the release GitHub App." }
    - { name: "ANDROID_KEYSTORE_B64", scope: "env production", purpose: "Android upload keystore, base64." }
    - { name: "ANDROID_KEYSTORE_PASSWORD", scope: "env production", purpose: "Password of the Android upload keystore." }
    - { name: "ANDROID_KEY_ALIAS", scope: "env production", purpose: "Alias of the Android upload key." }
    - { name: "ANDROID_KEY_PASSWORD", scope: "env production", purpose: "Password of the Android upload key." }
    - { name: "PLAY_SERVICE_ACCOUNT_JSON", scope: "env production", purpose: "Play Console service account that uploads to internal testing." }
    - { name: "ASC_KEY_ID", scope: "env production", purpose: "App Store Connect API key id for TestFlight upload." }
    - { name: "ASC_ISSUER_ID", scope: "env production", purpose: "App Store Connect API issuer id." }
    - { name: "ASC_PRIVATE_KEY", scope: "env production", purpose: "App Store Connect API private key (.p8)." }
    - { name: "IOS_DIST_CERT_P12", scope: "env production", purpose: "iOS distribution certificate, base64 .p12." }
    - { name: "IOS_DIST_CERT_PASSWORD", scope: "env production", purpose: "Password of the iOS distribution certificate." }
  # Store and signing secrets stay in production only: the app sign and upload jobs run in production, never in production-rollout.
  # The developer and reviewer App keys never enter CI.
  secrets-staleness-threshold-days: 90
  ci-ergonomics:
    dep-cache: true
    matrix: { os: ["ubuntu-latest"], versions: ["mise.toml"] }   # iOS jobs alone run on macos-latest
    release-concurrency: true
    rollback-concurrency: "rollback.yml has its own concurrency group; it never cancels or queues behind a release run"
    deploy-lock: "every deploy, rollback, and restore holds one VPS lock; a second caller waits or fails and never interleaves"
    install-hardening: "pnpm install --frozen-lockfile --ignore-scripts; pnpm-workspace.yaml lists the build scripts that may run"
    path-filters: false

# Block D — post-publish verification contract
post-publish-checks:
  - { kind: cell-health, cmd: "mise run check:cells -- --env production --version <tag>", expect: "all 4 production cells report up on <tag>" }
  - { kind: alarms-intact, cmd: "mise run check:alarms -- --env production", expect: "every cell has a next alarm at or before its earliest routine timer" }
  - { kind: heartbeats-green, cmd: "mise run check:heartbeats -- --since-deploy", expect: "a fresh ping from every cell and routine inside the window" }
  - { kind: app-build-processed, cmd: "mise run check:app-builds -- --version <app-tag>", expect: "build processed in Play internal testing and TestFlight (app track only; 60-minute ceiling)" }
propagation-window-min-minutes: 1
propagation-window-max-minutes: 15
poll-interval-seconds: 30

# Block E — rollout + rollback contract
rollout-strategy: staged
rollout-stages: ["owner-cell", "second-person-cell + household-cell", "secrets-cell"]
migration-policy: expand-contract   # the prior release always reads and writes the current storage
rollback-mechanism: redeploy-prior
rollback-time-estimate-min: 10
rollback-cmd: "mise run deploy -- --env production --cells <cells> --version <prior-tag>"
rollback-verify-cmd: "mise run check:cells -- --env production --cells <cells> --version <prior-tag> && mise run check:alarms -- --env production && mise run check:heartbeats -- --since-deploy"
rollback-guard: "the deploy refuses a downgrade across a contract step; that case goes to the restore path"
restore-cmd: "mise run restore -- --env production --cells <cells> --snapshot pre-<tag>-<run-id>"
restore-policy:
  trigger: "disaster only: a cell's data is corrupt, or a needed downgrade crosses a contract step"
  approval: "the owner's yes for each cell; never automatic"
  excluded-cells: ["secrets-cell"]   # a restore would revive rotated or revoked credentials; rebuild it instead
  snapshot-id: "pre-<tag>-<run-id>; snapshot-cells writes it and records it in the deploy ledger"
  data-loss-window: "every cell write between the snapshot and the restore; the run record states it before the owner approves"
  outbound-effects: "sent mail, calendar writes, and other outbound effects are logged outside the cell; a restored cell reads that log and does not repeat them"
prior-artifact-retention: "last 5 server bundles in the VPS release store, mirrored to the off-provider bucket; never on GitHub"
irreversible-steps:
  - "A snapshot restore discards every cell write after the snapshot; the run record states that window before the owner approves."
  - "A contract step removes storage that older releases need; after it ships, a rollback past it needs a restore."
  - "App builds delivered to testers cannot be recalled; a fix ships as a higher VERSION_CODE."
  - "Tags and GitHub Releases on the public repo are visible at once."
  - "Mail or messages an agent sent while a bad release ran cannot be unsent."
db-migrations-reversible: false

# Block F — recovery playbooks
recovery-playbooks:
  - id: conformance-fail
    triggers: ["conformance.*(fail|FAIL)", "storage conformance suite", "adapter.*(mismatch|violat)"]
    steps:
      - "Stop the release; do not promote past the test cell."
      - "Keep the production cells on the current tag."
      - "If a fork bump caused it, revert the pin to the prior fork tag in a PR."
      - "Open an issue with the failing conformance cases and the fork tags involved."
  - id: cell-adopt-fail
    triggers: ["adopt.*(fail|timeout)", "cell .* still on v", "version mismatch.*cell"]
    steps:
      - "Halt the staged rollout at the current stage."
      - "Redeploy the prior tag to the failing cell with the rollback command and --cells <cell>."
      - "Run the Block D checks against the failing cell."
      - "If the deploy refuses the downgrade at a contract step, or the cell data is corrupt, follow cell-restore. Do not restore in any other case."
  - id: cell-restore
    triggers: ["downgrade.*contract step", "refus.*contract", "(database|sqlite).*(corrupt|malformed)", "integrity_check.*(fail|not ok)"]
    steps:
      - "Take the VPS deploy lock, so no deploy or rollback runs during the restore."
      - "Read the snapshot id pre-<tag>-<run-id> from the deploy ledger."
      - "State the data-loss window: the snapshot time to now."
      - "Ask the owner for a yes for each cell, with the window. Restore only the cells that get a yes."
      - "Do not restore the secrets cell. If the secrets cell is damaged, rebuild it and rotate its credentials."
      - "Run the restore command for the approved cells."
      - "Confirm that each restored cell reads the outbound-effects log and repeats no sent mail or calendar write."
      - "Run the Block D checks against the restored cells."
  - id: alarm-lost
    triggers: ["no next alarm", "alarm.*(missing|unset|null)", "missed briefing"]
    steps:
      - "Re-arm the cell alarm to the earliest pi-durable task timer."
      - "Confirm the next briefing time for every person cell."
      - "Alert the owner by push and email with the affected cells."
      - "Open an issue; treat the release as bad until the cause is known."
  - id: apple-signing
    triggers: ["(certificate|provisioning profile).*(expired|invalid|not found)", "App Store Connect.*(401|403|unauthorized)", "altool|notarytool|pilot.*error"]
    steps:
      - "Check the expiry of the iOS distribution certificate and the App Store Connect API key."
      - "Renew the expired item in the Apple developer account."
      - "Replace the matching secret in the production environment."
      - "Rerun the app release workflow for the same app tag."

# Block G — stakeholder + announcement contract
announcement:
  channels: []
  template-path: ".ai/release-announcement-template.md"

# === Inbound half — read by /wf ship-plan build (and the local gate in /wf handoff) ===

# Block H — code-quality gates
code-quality:
  format-check: { tool: "biome", cmd: "pnpm biome ci ." }
  lint:         { tool: "biome+ktlint+detekt", cmd: "pnpm biome ci . && ./gradlew -p app ktlintCheck detekt" }
  type-check:   { tool: "tsc", cmd: "pnpm -r exec tsc --noEmit" }
  test-coverage: { min-percent: 80, cmd: "pnpm -r vitest run --coverage" }   # server and extensions; no gate on app UI code
  commit-convention:   { spec: conventional, config-path: "commitlint.config.mjs", enforce: [local, ci] }
  pr-title-convention: { spec: conventional, enforce: [ci] }

# Block I — local developer experience
local-dx:
  git-hooks:
    framework: lefthook
    hooks:
      pre-commit: ["gitleaks protect --staged --redact", "pnpm biome check --staged --no-errors-on-unmatched", "./gradlew -p app ktlintCheck (only when app/ files are staged)"]
      commit-msg: ["pnpm commitlint --edit {1}"]
      pre-push:   ["pnpm -r vitest run --changed"]
  editorconfig: true
  runtime-version-files: ["mise.toml"]
  task-runner:
    kind: mise
    targets:
      setup: "pnpm install && lefthook install"
      check: "biome, tsc, ktlint, detekt"
      test: "pnpm -r vitest run --coverage"
      build: "server bundle and app debug build"
      "deploy:dry-run": "build the server bundle and diff it against the test cell"
      deploy: "deploy a tag to an environment over the private network"
      "check:cells": "cell health on an environment"
      "check:alarms": "next-alarm check on every cell"
      "check:heartbeats": "heartbeat freshness since the deploy"
      "check:app-builds": "Play internal and TestFlight processing state"
  bootstrap-cmd: "mise install && mise run setup"
  contributing-doc: false   # AGENTS.md is the contributor guide

# Block J — repo governance
governance:
  github-apps:
    - { name: developer, permissions: { contents: write, pull-requests: write }, never: ["workflows", "actions", "administration", "environments", "secrets"], key-location: "agent host only; never in CI" }
    - { name: reviewer, permissions: { contents: read, pull-requests: write }, key-location: "agent host only; never in CI" }
    - { name: release, permissions: { contents: write, pull-requests: write, issues: write }, used-by: "release-please on main", key-location: "release environment (main only)" }
  branch-protection:
    base-branch: "main"
    mechanism: branch-protection
    required-checks:
      - biome
      - type-check
      - test-server
      - ktlint
      - detekt
      - app-build
      - commitlint
      - pr-title
      - codeql-javascript-typescript
      - codeql-java-kotlin
      - gitleaks
      - osv-scanner
      - license-check
    required-approvals: 1          # the reviewer GitHub App, on a different model from the author
    dismiss-stale-reviews: true
    require-last-push-approval: true   # a push after the approval needs a new approval from someone other than the pusher
    require-up-to-date: true
    enforce-admins: false          # the owner can merge own safety-path PRs; agent PRs cannot bypass
    require-code-owner-reviews: true
    require-conversation-resolution: true
    require-linear-history: false
    allow-force-pushes: false
    allow-deletions: false
    apply-via: gh-api
  tag-protection:
    mechanism: ruleset
    patterns: ["v*", "app-v*"]
    restrict: [creation, update, deletion]
    bypass-actors: ["release GitHub App", "repository admin (owner)"]
    ancestry-check: "release-server.yml and release-app.yml refuse a tag whose commit is not on main"
  codeowners:
    # Safety paths are provisional until wave 2 creates them; update the globs in that PR.
    - { path: "/packages/safety/", owners: ["@jayteealao"] }
    - { path: "/packages/tool-hook/", owners: ["@jayteealao"] }
    - { path: "/packages/reviewer/", owners: ["@jayteealao"] }
    - { path: "/packages/secrets-cell/", owners: ["@jayteealao"] }
    - { path: "/packages/budgets/", owners: ["@jayteealao"] }
    - { path: "/packages/rules/", owners: ["@jayteealao"] }
    # The gates themselves are guards too: an agent must not weaken CI or ownership.
    - { path: "/.github/", owners: ["@jayteealao"] }
    - { path: "/lefthook.yml", owners: ["@jayteealao"] }
    - { path: "/renovate.json", owners: ["@jayteealao"] }
    - { path: "/.ai/ship-plan.md", owners: ["@jayteealao"] }
    # Files that change what CI runs, installs, or trusts are gates too.
    - { path: "/mise.toml", owners: ["@jayteealao"] }
    - { path: "/package.json", owners: ["@jayteealao"] }
    - { path: "/pnpm-workspace.yaml", owners: ["@jayteealao"] }
    - { path: "/pnpm-lock.yaml", owners: ["@jayteealao"] }
    - { path: "/release-please-config.json", owners: ["@jayteealao"] }
    - { path: "/.release-please-manifest.json", owners: ["@jayteealao"] }
    - { path: "/biome.json", owners: ["@jayteealao"] }
    - { path: "/commitlint.config.mjs", owners: ["@jayteealao"] }
    - { path: "vitest.config.*", owners: ["@jayteealao"] }
    - { path: "/.gitleaks.toml", owners: ["@jayteealao"] }
    - { path: "/osv-scanner.toml", owners: ["@jayteealao"] }
    - { path: "/AGENTS.md", owners: ["@jayteealao"] }
    - { path: "/CLAUDE.md", owners: ["@jayteealao"] }
    - { path: "/infra/", owners: ["@jayteealao"] }
  pr-template: true
  issue-templates: true
  dependency-automation: { tool: renovate, ecosystems: ["npm", "gradle", "github-actions", "mise", "git-tags (fork pins)"], schedule: "weekly" }
  merge: { method: squash, auto-merge: true, merge-queue: false }

# Block K — security & supply-chain gates
security:
  sast:             { tool: codeql, cmd: "", schedule: "on pull_request and weekly" }   # languages: javascript-typescript, java-kotlin
  dependency-audit: { tool: "osv-scanner", cmd: "mise run audit:deps", fail-on: "CVSS >= 7.0, any unscored finding, or any MAL-* id", allowlist: "osv-scanner.toml; every entry has a reason and an expiry date" }
  secret-scanning:  { tool: gitleaks, cmd: "gitleaks git --redact --no-banner", pre-commit: true }   # plus GitHub secret scanning with push protection
  sbom:             { tool: syft, format: spdx, publish-with-release: true }
  license-check:    { tool: "pnpm licenses + allowlist script", cmd: "mise run audit:licenses", mode: allowlist, allow: ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MPL-2.0", "0BSD", "Python-2.0", "CC0-1.0", "CC-BY-4.0", "BlueOak-1.0.0", "Unlicense"], deny: ["GPL-*", "AGPL-*", "UNKNOWN"] }   # any license outside allow fails; deny names the common cases

# === Extensions — open schema, not read by /wf ship unless a consumer opts in by id ===

additional-contracts:
  - id: upstream-fork-sync
    purpose: "Keep the private pi-durable and celld forks current without breaking the live cells."
    fields:
      forks: ["pi-durable (private fork)", "celld (private fork)"]
      visibility: private
      fork-ci: { pi-durable: "storage conformance suite + unit tests", celld: "cargo test + clippy + release binary build" }
      fork-release: "each fork tags its own releases"
      pin: "Secbot pins an exact fork tag; no branch or floating ref"
      bump-path: "Renovate or a manual PR bumps the pin; the PR passes all pre-merge checks; the release passes the test cell before production"
      upstream-merge: "by hand into the fork; celld 0.x can break compatibility"
      secret-access: "FORKS_READ_TOKEN: fine-grained PAT, contents read on the two fork repos only, 30-day expiry; only the install step receives it, through GIT_CONFIG_* env, with --ignore-scripts; outside fork PRs skip fork-dependent jobs"
    enforced-by: "fork CI, Secbot pre-merge checks, the release workflow's conformance and verify-test-cell jobs"
  - id: data-migration
    purpose: "Protect cell data across releases that change cell storage."
    fields:
      stores: ["cell SQLite (one per cell)", "pi-durable storage adapter state"]
      direction: expand-contract
      expand: "a release adds storage and keeps the old shape readable and writable, so the prior release still runs on it"
      contract: "a later release removes the old shape only after the expand release runs on every cell; the deploy ledger marks the contract step"
      pre-deploy: "snapshot-cells takes snapshot pre-<tag>-<run-id> of every production cell to the off-provider bucket"
      rollback-across-migration: "redeploy the prior tag with no restore; a downgrade past a contract step is refused and goes to cell-restore"
      restore: "disaster step only; Block E restore-policy"
      restore-drill: "restore one cell snapshot into the test cell once per month"
    enforced-by: "release workflow snapshot-cells job; the deploy downgrade guard; /wf ship rollback"
  - id: infrastructure-as-code
    purpose: "Describe the VPS, network, proxy, backups, and heartbeats as reviewable config without exposing them."
    fields:
      scope: ["VPS base config", "reverse proxy with TLS, Google sign-in, and passkeys", "private network", "off-provider S3-compatible bucket", "outside heartbeat service"]
      location: "infra/"
      tool: "chosen in wave 1 (cell-runtime plan)"
      public-repo-rule: "no secrets, hostnames, IP addresses, or account ids in infra/; they come from environment secrets"
      drift-check: monthly
    enforced-by: "/wf ship-plan audit; code-owner review on /infra/ once it exists"
  - id: mobile-app-store
    purpose: "Ship the Compose Multiplatform app to the two household phones through private test tracks."
    fields:
      release-workflow-file: ".github/workflows/release-app.yml"
      trigger: "tag app-v*"
      jobs: ["build-android", "build-ios (macos-latest)", "sign", "upload-play-internal", "upload-testflight", "sbom", "github-release"]
      android: "Play Console internal testing"
      ios: "TestFlight internal testers"
      public-listing: false
      version-code: "strictly increasing; release-please bumps it with VERSION_NAME"
      signing-material: "production environment secrets; never on a self-hosted runner"
    enforced-by: "release-app.yml behind the production environment approval"
---

# Ship Plan — Secbot

## What "ship" means here
Secbot ships on two tracks. The server track is a rolling, in-place deploy to one small cloud VPS that runs celld. celld adopts new code in place, and pi-durable extensions can be replaced while conversations run. So cells keep their SQLite data and their alarms across a release. The app track sends the Compose Multiplatform app to Play internal testing and TestFlight internal testers, with no public store listing. Releases run on demand. Evidence: the brainstorm decisions "celld runs on a small cloud VPS" and "deployed only after pi-durable's storage conformance suite and a test cell pass". The repo has no CI or code yet, so every command below is a target for `/wf ship-plan build`.

The plan uses four GitHub environments:
- `test-cell`: every release goes here first. It promotes automatically when it passes.
- `production`: waits for the owner's approval. It runs the snapshot and the owner-cell stage.
- `production-rollout`: runs the later stages with no second approval. Each job checks the VPS deploy ledger first. The ledger record must match the job's own tag, run id, and run attempt, and no newer deploy or rollback may exist. A re-run or a stale run therefore cannot reuse an old approval.
- `release`: holds the release App key for release-please. Only `main` can use it.

## Versioning
Each track has its own SemVer line. The server tags `v<x.y.z>` from `package.json`. The app tags `app-v<x.y.z>` from `app/gradle.properties`, and `VERSION_CODE` only increases. release-please reads conventional commits and opens one release PR per component in manifest mode. `.release-please-manifest.json` records both versions. A release PR passes the same merge gate as any other PR. There is no prerelease suffix, because the test cell and the test tracks are the prerelease stage. There is no post-release snapshot bump.

## CI/CD pipeline
Every PR into `main` must pass 13 checks, listed in Block C. Block H and Block K define the command behind each check. Merging a release PR creates the tag. A `v*` tag starts `release-server.yml`: build, conformance suite, SBOM, deploy and verify the test cell, snapshot the cells, then the staged production deploy, then the GitHub release. An `app-v*` tag starts `release-app.yml`.

Each secret lives in the narrowest environment that needs it:
- The test cell has its own SSH key and its own private-network client (`tag:ci-test`). The key belongs to a separate VPS user. A forced command limits that user to staging a bundle and deploying it to the test cell.
- The production SSH key and the `tag:ci-prod` network client exist only in `production` and `production-rollout`.
- The store and signing secrets exist only in `production`. The app sign and upload jobs run there.
- The release App key exists only in `release`. The developer and reviewer App keys never enter CI.
- `FORKS_READ_TOKEN` is a fine-grained PAT with read access to the two fork repos only, and it expires after 30 days. Only the install step receives it, through `GIT_CONFIG_*` env. The install runs with `--ignore-scripts`, so no package script sees the token.

The server bundle contains private fork code, so it never becomes a workflow artifact or a release asset. The build job stages the bundle on the VPS release store through the test-cell deploy path. Later jobs refer to it by tag and SHA-256. The public GitHub release carries only the SBOM, the checksum, and a build-provenance attestation.

The rollback workflow has its own concurrency group. Every deploy, rollback, and restore also holds one VPS lock, so two of them never interleave. The runner joins the private network with an ephemeral key, and the VPS exposes no public SSH port. iOS builds run on GitHub-hosted macOS, because a self-hosted runner on a public repo lets an outside PR run code on the home Mac. The agents' runtime keys (OpenRouter, AgentMail, Google, Firebase) stay in the secrets cell and never enter CI.

## Post-publish verification
After each production stage, four signals must hold within 1 to 15 minutes, polled every 30 seconds:
- All production cells report up on the new tag.
- Every cell still has its next alarm, so no briefing is missed.
- The heartbeat service shows a fresh ping from every cell and routine.
- On the app track, the build shows as processed in both test tracks, with a 60-minute ceiling.

## Rollout strategy
The rollout is staged across the live cells. The owner's person cell goes first. The second person cell and the household cell go next. The secrets cell goes last. The Block D checks run after each stage, so a bad release reaches the owner before anyone else and reaches the secrets cell last.

## Rollback playbook
Detection: a Block D check fails, or the heartbeat service alerts. Site reliability may roll back only after the owner taps yes on a phone push. The rollback redeploys the prior tag to the affected cells (`--cells`), then reruns the Block D checks. The bundle comes from the VPS release store (last 5 tags), or from the off-provider bucket when the VPS copy is missing. The target time is under 10 minutes.

Storage changes follow expand–contract. A release that changes storage keeps the old shape readable and writable, so the prior release still runs on it. A normal rollback therefore restores no data. A later release removes the old shape only after every cell runs the expand release. The deploy refuses a downgrade past that contract step.

A snapshot restore is a disaster step, not a rollback step. It applies only when a cell's data is corrupt or a needed downgrade crosses a contract step. The `cell-restore` playbook runs it for one cell at a time, after the owner's yes for that cell. Before the yes, the run record states the data-loss window: every write between the snapshot `pre-<tag>-<run-id>` and the restore. The secrets cell is never restored, because a restore would revive rotated or revoked credentials. Outbound effects (sent mail, calendar writes) are logged outside the cell, so a restored cell does not repeat them. The code fix follows as a normal PR.

## Recovery playbooks
The repo has no runbooks, so these five seeds come from the failure modes in the brainstorm and the rollback contract:
- `conformance-fail`: the storage conformance suite fails.
- `cell-adopt-fail`: a cell does not adopt the new code. The fix is a redeploy of the prior tag, never a restore.
- `cell-restore`: the disaster path, when cell data is corrupt or a downgrade crosses a contract step.
- `alarm-lost`: a cell loses its next alarm.
- `apple-signing`: TestFlight signing or the API key fails.

Add new playbooks with `/wf ship-plan edit` when real failures happen.

## Stakeholder + announcement
There is no announcement channel. GitHub Releases carry the release-please changelog.

## Code-quality gates
- Biome checks format and lint for TypeScript.
- ktlint and detekt check the Kotlin app.
- `tsc --noEmit` runs in strict mode.
- vitest coverage on the server and the extensions must stay at 80% or higher. App UI code has no coverage gate.
- commitlint checks conventional commits on `commit-msg` locally and in CI.
- A PR-title lint runs in CI, because the squash merge uses the PR title as the commit.

Every gate here is a required pre-merge check.

## Local developer experience
lefthook runs these hooks:
- `pre-commit`: gitleaks, then Biome on the staged files, then ktlint when app files are staged.
- `commit-msg`: commitlint.
- `pre-push`: the vitest tests for changed packages.

mise pins Node, pnpm, and Java, and holds the tasks. The same setup works on Windows, WSL2, the VPS, and the home Mac. A new checkout runs `mise install && mise run setup`. The repo ships a `.editorconfig`. `AGENTS.md` is the contributor guide.

## Repo governance
The repo is public, and the base branch is `main`. `/wf ship-plan build` applies branch protection and the tag ruleset through `gh api`, behind its own confirmation gate. The branch rules are:
- All 13 checks are required, and the branch must be up to date.
- One approval is required. It comes from the reviewer GitHub App, which runs on a different model from the developer App that authors the PR.
- Stale approvals are dismissed. A push after the approval needs a new approval from someone other than the pusher.
- Code-owner review is required.
- Conversations must be resolved.
- Force pushes and deletions are blocked.

Three GitHub Apps split the work:
- The developer App writes contents and pull requests. It has no workflows, actions, administration, environments, or secrets permission. Its key stays on the agent host.
- The reviewer App reads contents and writes pull-request reviews. Its key stays on the agent host.
- The release App runs release-please on `main` and creates the tags. Its key lives in the `release` environment.

A tag ruleset restricts the creation, update, and deletion of `v*` and `app-v*` tags to the release App and the owner. Both release workflows also refuse a tag whose commit is not on `main`.

`enforce-admins` is off, so the owner can merge their own safety-path PRs. An agent PR cannot bypass the rules. CODEOWNERS assigns `@jayteealao` to the safety paths (rules, tool hook, reviewer, secrets cell, budgets) and to every file that changes what CI runs, installs, or trusts: `.github/`, the hook, Renovate, mise, package, workspace, lockfile, release-please, Biome, commitlint, vitest, gitleaks, and osv-scanner configs, `AGENTS.md`, `CLAUDE.md`, `infra/`, and this plan. An agent therefore cannot weaken its own guards. Because the lockfile is owned, every dependency change, Renovate PRs included, needs the owner's review. The safety-path globs are provisional until wave 2 creates those packages. Merges are squash-only, with auto-merge on. Renovate runs weekly for npm, Gradle, GitHub Actions, mise, and the fork pins. The repo ships PR and issue templates.

## Security & supply-chain gates
- CodeQL runs on every PR and weekly, for TypeScript and for Kotlin.
- GitHub secret scanning with push protection is on. gitleaks (`gitleaks git`) also runs in CI and as a pre-commit hook.
- osv-scanner fails a PR on a finding with CVSS 7.0 or higher, on any unscored finding, and on any `MAL-*` (malicious package) id. The only exception is an entry in `osv-scanner.toml` with a reason and an expiry date.
- syft attaches an SPDX SBOM to each GitHub release.
- The license gate reads `pnpm licenses list --json` and checks it against an allowlist: MIT, Apache-2.0, BSD-2/3, ISC, MPL-2.0, 0BSD, Python-2.0, CC0-1.0, CC-BY-4.0, BlueOak-1.0.0, and Unlicense. Any other license fails, including the GPL and AGPL family and an unknown license.

All of these except the weekly CodeQL run are PR-time gates.

## Additional contracts
### upstream-fork-sync
The pi-durable and celld forks stay private and run their own CI: the conformance suite for pi-durable, and cargo test plus a binary build for celld. Each fork tags its own releases. Secbot pins exact fork tags. A bump goes through a PR and then the test cell. Secbot CI reads the forks with `FORKS_READ_TOKEN`, a fine-grained read-only PAT on the two fork repos that expires after 30 days. Only the install step receives the token, and the install runs no package scripts. Outside PRs skip the jobs that depend on the forks.

### data-migration
Cell storage changes follow expand–contract. An expand release adds storage and keeps the old shape usable, so the prior release still runs on it and a rollback is a plain redeploy. A contract release removes the old shape only after the expand release runs on every cell, and the deploy ledger marks that step. Before every production deploy, `snapshot-cells` takes snapshot `pre-<tag>-<run-id>` of every production cell to the off-provider bucket. A restore from that snapshot is a disaster step under the Block E restore policy. Once a month, a restore drill loads one snapshot into the test cell.

### infrastructure-as-code
The VPS config, the reverse proxy (TLS, Google sign-in, passkeys), the private network, the backup bucket, and the heartbeat service live under `infra/`. The tool is chosen in wave 1. Because the repo is public, `infra/` holds no secrets, hostnames, IP addresses, or account ids. `/wf ship-plan audit` runs a drift check monthly.

### mobile-app-store
`release-app.yml` runs on `app-v*` tags and builds Android and iOS. The iOS build runs on GitHub-hosted macOS. The workflow uploads to Play internal testing and TestFlight internal testers, behind the production environment approval. The signing material lives only in production environment secrets.
