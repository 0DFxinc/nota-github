# Nota + GitHub

Two things Nota does inside GitHub, both on the Nota GitHub App:

| | What it looks like | Setup |
| --- | --- | --- |
| **Ask Nota in a comment** | You comment `/nota create a test plan for this PR`; Nota replies in the thread. | [below](#ask-nota-in-a-comment) |
| **Test gate** | Nota runs your suite against the pull request's deployment and gives the calling job the same conclusion. | [below](#test-gate) |

Install the App first: it is what lets Nota read the pull request, reply in the
thread, and publish the check. Nota gives you the install link, which binds the
installation to your Nota workspace, so use that link rather than the
Marketplace page.

---

## Ask Nota in a comment

### 1. Install the GitHub App

An organization owner installs it and grants access to the repositories Nota
should work in. Nota gives you the install link; it binds the installation to
your Nota workspace, so use the link rather than installing from the
Marketplace page.

The App requests these repository permissions. Setup rejects a weaker grant
rather than failing later inside a run:

| Permission      | Access | Why                         |
| --------------- | ------ | --------------------------- |
| Issues          | Write  | Post the reply on an issue  |
| Pull requests   | Write  | Post the reply on a PR      |
| Contents        | Read   | Read the diff for context   |
| Checks          | Write  | Publish the gate result     |
| Deployments     | Read   | Know when a preview is live |
| Actions         | Read   | Match a run to its workflow |
| Commit statuses | Write  | Report status on a commit   |
| Metadata        | Read   | Required by GitHub          |
| Merge queues    | Read   | Support merge-queue gating  |

### 2. Comment on an issue or a PR

```text
/nota create a test plan for this PR
```

Nota edits one comment in place: `Working on it…` first, then the result.

Expect about a minute before work starts, plus the work itself. Discovery
against a real app takes several minutes.

**Every command needs the `/nota` prefix.** Replying in prose in the same thread
is not picked up, including when you are answering a question Nota asked.

**Name the area you want covered.** Nota matches what you write against the
pages it knows about in your app, so the shortest path is to name the page as it
appears in Nota:

```text
/nota create a test plan for the Cart page
```

If it cannot tell which area you mean, it asks; answer with another `/nota`
comment. Two things save you that round-trip:

- Nota takes the scope from your command text. It does not infer it from the
  pull request's diff, so name the area explicitly even on a PR.
- Use a word from the page's own title. `Cart flow` does find a page listed as
  `Cart - Demo Shop`, but a synonym will not: `shopping basket` matches nothing
  and Nota asks.

### What comment commands do not do yet

- **Inline review comments are not picked up.** Use a normal issue or PR
  comment, not a comment on a specific line of the diff.
- **Nota cannot comment on, assign, close or reopen an existing GitHub issue
  from chat.** Creating one and reading them back are supported; the other
  actions are not, and Nota will say so rather than approximating them with a
  new issue.

### What you can ask for in chat

Once the App is installed, you can ask Nota to open a GitHub issue or read
existing ones in any repository the installation covers, with no personal access
token, and any member of the organization can ask, not only an admin:

- "Open a GitHub issue in acme/web about the flaky guest-checkout run."
- "What issues are open in acme/web?"

Nota files the issue through the App installation, so it appears as the Nota
app rather than as one of your users. A repository the App is not installed
on is refused by name; add it to the installation to make it available.

---

# Test gate

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

---

## Security

Report security issues privately to `security@trynota.ai`. Do not open public
issues containing credentials, OIDC tokens, customer targets, or run output.
