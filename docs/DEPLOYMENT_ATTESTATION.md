# Deployment attestation v1

Nota supports two intentionally different GitHub CI products:

- `STATIC_SMOKE` runs an informational `SEQUENCE` suite against one exact,
  administrator-configured HTTPS origin. It does not claim that the origin
  contains the pull-request SHA and can never become a required Nota gate.
- `CI_GATE` with the Vercel adapter creates App-owned GitHub deployment
  evidence for one unique per-run Vercel preview and may become required only
  after an informational end-to-end qualification and ruleset proof.

Generic required attestation for an arbitrary fixed URL is not supported in
v1. Writing a fresh marker beside stale content would not prove which bytes
were deployed. Existing fixed-origin gates must retain their independently
trusted dedicated-CD-App deployment proof.

## Vercel setup

Create a dedicated Vercel project used only for Nota previews. It must not be
Git-connected and must have no Preview environment variables, integrations,
Secure Backend Access/OIDC, automation bypass, or deployment protection. The
remote build receives no GitHub, Nota, or Vercel credential.

Create a fine-scoped Vercel access token and store it as the only secret named
`VERCEL_TOKEN` in a dedicated GitHub environment such as `nota-ci`. Configure
that environment with:

1. exactly one selected branch rule: the repository's literal current default
   branch (not a tag or wildcard);
2. at least one reviewer other than the person who triggered the run;
3. self-review disabled; and
4. no custom deployment protection rule.

The reusable job uses `environment.deployment: false`, so reviewer and branch
protection still gate secret access without emitting an Actions-owned
Deployment. Do not place the token at repository or organization scope and do
not pass `secrets: inherit` to either reusable workflow.

The Nota GitHub App needs repository metadata, Actions, pull-request and
Deployment read access for existing gates. The new Vercel adapter additionally
needs Deployment write access. Nota's setup validator reports the missing
capability; existing gates continue to work without it.

Before using the adapter, remove or disable every active default-branch
workflow triggered by `deployment` or `deployment_status`. The validator fails
closed when it finds one because an App-created Deployment or status could
otherwise start unrelated jobs with their own credentials.

Register the protected caller workflow path, its protected-base blob, the
GitHub environment, the dedicated Vercel project/team IDs, project directory,
and the exact marker file
`public/.well-known/nota-deployment.json` in an informational Nota policy. The
suite must use `SEQUENCE` mode.

Run the non-mutating setup validator as a job in the same protected
`pull_request_target` caller after opening a same-repository test PR. The App
gate and PR/run association must already exist, but the validator performs no
Deployment, status, policy, suite, environment, or Vercel mutation:

```yaml
jobs:
  validate:
    uses: 0DFxinc/nota-github/.github/workflows/preflight.yml@d5b1a40433986bc9d07062d650049f909c0a47d1
    with:
      policy-id: 00000000-0000-4000-8000-000000000000
      nota-environment: development
      github-environment: nota-ci
```

Replace the sample UUID and use [the Vercel preview example](../examples/vercel-preview.yml)
from the protected default branch. The caller must use `pull_request_target`.
Nota rejects forks, a caller introduced by the pull request, ambiguous PR/run
associations, non-default bases, and any source SHA not re-read through the
App. The trusted workflow never executes source from the pull request; it only
copies regular files into a bounded upload tree.

The adapter uses the unique deployment URL. It never creates, changes, or
reads a stable alias. Nota creates or adopts a GitHub Deployment before the
upload, returns the exact canonical marker containing its final ID, and only
creates the successful status after the provider record and served marker have
both been re-read. A rerun recovers with the same semantic key; an ambiguous
provider mutation is quarantined instead of blindly repeated.

## Fixed-origin smoke setup

Create a `STATIC_SMOKE` policy for an exact HTTPS origin and an exact trigger
and source ref. The policy must be informational. Each run uses a distinct
Check name `Nota / Static Smoke v1 / <full-sha>` so it cannot become a stable
required context. It has no GitHub environment, secrets,
Deployment, marker, or artifact fields. Use
[the static example](../examples/static-smoke.yml).

If the fixed origin has not deployed the triggering SHA, the smoke test may
exercise older content. That limitation is shown in the Check result. The
smoke Check cannot satisfy `Nota / Test Gate v1`; Nota's validator rejects a
ruleset that selects the smoke context.

## Actionable preflight errors

The validator fails before mutation and returns a stable code for a missing App
installation or capability, disabled/wrong-kind policy, non-`SEQUENCE` suite,
caller blob mismatch, unsafe GitHub environment, active deployment listener,
missing protected `VERCEL_TOKEN`, wrong Vercel project/team, Git-connected or
credential-bearing Vercel project, project or team-shared Preview variables,
attached integration resources, Secure Backend Access/OIDC, automation bypass,
target redirect/private address, and marker mismatch. It never prints secret
values or provider response bodies.

Start with `INFORMATIONAL`. A required ruleset is an operator-controlled later
step after one passing and one intentionally failing end-to-end canary. This
repository does not merge, deploy, promote, or alter customer configuration.
