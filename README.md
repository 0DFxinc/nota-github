# Nota GitHub test gate

This public repository contains Nota's reusable GitHub Actions workflow. The
workflow authenticates to Nota with GitHub OIDC, joins an App-owned gate, waits
for the authoritative SEQUENCE-suite result, and gives the calling GitHub job
the same conclusion.

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
