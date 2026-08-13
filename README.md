# Nota GitHub CI workflows

This public repository contains SHA-pinned reusable workflows for Nota's
GitHub test gate, informational fixed-origin smoke testing, and first-class
Vercel preview deployment attestation. They authenticate with GitHub OIDC; no
Nota API key or PAT is accepted.

For new onboarding, read [Deployment attestation v1](docs/DEPLOYMENT_ATTESTATION.md)
and start with the [Vercel](examples/vercel-preview.yml) or
[fixed-origin smoke](examples/static-smoke.yml) example. The setup validator is
`.github/workflows/preflight.yml`.

The Vercel workflow automatically creates the Nota-App GitHub Deployment,
places the exact four-field marker in a sanitized copy of the application
before remote build, verifies the unique provider URL and served marker, and
creates the successful Deployment Status. It does not execute pull-request
code on the token-bearing runner and does not use stable aliases.

Static smoke is deliberately informational and nonpromotable. An arbitrary
fixed host cannot prove PR-SHA freshness merely by accepting a new marker, so
generic required fixed-URL attestation remains unsupported in v1.

Admission is a bounded operation: a gate that is still waiting on its App
webhook is retried with backoff for at most five minutes. After admission, the
workflow uses authenticated database-only status reads, so polling does not
consume GitHub App API quota.

It does not accept a target URL, commit override, credential, or arbitrary Nota
endpoint. Production and development hosts are fixed in the reviewed workflow.

Pin the reusable workflow to the 40-character commit SHA shown on the Nota
release page. Do not use a branch or moving major-version tag for a required
check.

## Pull requests with preview deployments

Call Nota only after the job that deploys the exact PR SHA. Replace the local
deployment workflow and Nota policy ID with your values:

```yaml
name: Preview deployment and Nota gate

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  id-token: write

jobs:
  deploy-preview:
    uses: ./.github/workflows/deploy-preview.yml

  nota:
    needs: deploy-preview
    uses: 0DFxinc/nota-github/.github/workflows/run.yml@<40-character-release-commit>
    with:
      policy-id: <nota-policy-uuid>
      operation: JOIN_GATE
      nota-environment: development
      github-environment: customer-preview
```

Nota rejects fork PRs in v1. The deployment must publish GitHub Deployment
evidence for the same repository, commit SHA, and environment configured in the
policy.

## Merges to a development environment

Use an exact branch trigger and keep the same deploy-before-test dependency:

```yaml
name: Development deployment and Nota tests

on:
  push:
    branches: [development]

permissions:
  contents: read
  id-token: write

jobs:
  deploy-development:
    uses: ./.github/workflows/deploy-development.yml

  nota:
    needs: deploy-development
    uses: 0DFxinc/nota-github/.github/workflows/run.yml@<40-character-release-commit>
    with:
      policy-id: <nota-policy-uuid>
      operation: JOIN_GATE
      nota-environment: development
      github-environment: development
```

Push policies are informational in v1 because the push event happens after the
protected ref changes. Use a pull-request or merge-queue policy for a required
pre-merge gate.

## Run on demand

For an already deployed environment, expose a manual workflow:

```yaml
name: Run Nota on demand

on:
  workflow_dispatch:

permissions:
  contents: read
  id-token: write

jobs:
  nota:
    uses: 0DFxinc/nota-github/.github/workflows/run.yml@<40-character-release-commit>
    with:
      policy-id: <nota-policy-uuid>
      operation: DISPATCH_MANUAL
      nota-environment: development
      github-environment: development
```

The manual run uses the latest valid deployment evidence selected by Nota; it
does not accept a caller-supplied target URL or commit override.

## Required deployment attestation

Before enabling execution, the approved CD App must create a GitHub Deployment
for the exact repository, commit SHA, and environment. Its deployment payload
must include a stable `artifact_id` of 1–255 characters using only letters,
digits, `.`, `_`, `:`, or `-`. Its successful Deployment Status must set the
deployed HTTPS origin as `environment_url`.

That origin must serve `/.well-known/nota-deployment.json` as `application/json`
without a redirect:

```json
{
  "repository_id": "123456789",
  "deployment_id": "987654321",
  "deployed_sha": "0123456789abcdef0123456789abcdef01234567",
  "artifact_id": "preview-build-0123456789abcdef"
}
```

The two numeric IDs and full 40-character SHA must match GitHub's Deployment
and the gate. `artifact_id` must exactly match the immutable value in the
Deployment payload. Nota fetches at most 32 KiB, rejects redirects and private
or special-use network addresses, and rechecks the marker before browser
launch. V1 also requires every browser dependency to be served from that same
origin.

The deployed origin must also be authorized by the Nota target policy. Use an
exact origin for shared preview hosts such as `*.vercel.app`, `*.netlify.app`,
or `*.pages.dev`; Nota does not allow broad suffix authorization for shared
hosting domains. A suffix rule is appropriate only for a customer-controlled
domain.

Do not let a PR-controlled workflow mint this evidence. Nota enables execution
only after an administrator binds the policy to the dedicated CD App that owns
the Deployment and status.

## Nota setup and rollout

Nota's GitHub App must already be installed and an administrator must create
the policy. The administrator binds that policy to one suite, environment,
repository, trigger, exact caller workflow path, and protected GitHub
environment. Push policies also bind one exact `refs/heads/...` source ref. Do
not move the caller workflow or environment without updating the Nota policy
first.

Start with an informational policy. After a successful end-to-end canary,
promote a pull-request or merge-queue policy to required in Nota and add its
exact check context to the GitHub ruleset. The same reusable workflow supports
both modes; GitHub enforcement is controlled by the Nota policy.

## Security

Report security issues privately to `security@trynota.ai`. Do not open public
issues containing credentials, OIDC tokens, customer targets, or run output.
