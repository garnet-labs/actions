# Cognition Actions

Reusable actions for Devin blueprints: short-lived access to services through OpenID Connect (OIDC) without storing long-lived credentials in Devin, and security tooling for the Devin VM image.

These actions are intended for the `initialize` section of a Devin environment blueprint.

## Available actions

### Garnet record summary

`garnet-record-summary` writes a short, finalized current-head Garnet record to
the PR description, without copying execution trees. Run it after the trusted
Garnet App posts or edits its comment (or after the recording workflow completes).
It does not poll for finalization. Use trusted workflow code, never PR code, with
`pull-requests: write`; do not run it with a token from an untrusted checkout.

```yaml
- uses: garnet-labs/actions/garnet-record-summary@devin/record-summary
  with:
    github-token: ${{ github.token }}
    pr-number: ${{ github.event.issue.number }}
    publish-draft: "false"
    max-items: "8"
```

The managed block uses `<!-- garnet:record-summary:begin -->` / `end` delimiters.
A nonfinal record leaves the description alone unless an older summary needs
replacing with a current-head not-finalized notice. `publish-draft: "true"`
marks a draft ready only after writing a finalized summary. An identical rerun
does not write or publish. Existing human text is preserved. Counts and capture
quality come from Garnet; the summary is evidence, not approval. Run tests with
`node --test garnet-record-summary/test/*.test.mjs`.

| Action | Description |
| --- | --- |
| [`setup-devin-oidc`](./setup-devin-oidc/README.md) | Install the base `devin-oidc` CLI for OIDC token exchange |
| [`setup-aws-oidc`](./setup-aws-oidc/README.md) | Configure AWS CLI and SDK authentication with Devin OIDC |
| [`setup-gcp-oidc`](./setup-gcp-oidc/README.md) | Configure gcloud and Google Cloud SDK authentication with Devin OIDC |
| [`setup-vault-oidc`](./setup-vault-oidc/README.md) | Configure HashiCorp Vault CLI authentication with Devin OIDC |
| [`setup-jfrog-oidc`](./setup-jfrog-oidc/README.md) | Configure JFrog CLI authentication with Devin OIDC |
| [`setup-infisical-oidc`](./setup-infisical-oidc/README.md) | Configure Infisical CLI authentication with Devin OIDC |
| [`setup-azure-oidc`](./setup-azure-oidc/README.md) | Configure Azure CLI and Azure SDK authentication with Devin OIDC |
| [`setup-crowdstrike-falcon`](./setup-crowdstrike-falcon/README.md) | Install the CrowdStrike Falcon EDR sensor into the VM image (golden-image mode) |

## `setup-devin-oidc`

Installs the `devin-oidc` command-line tool. Use this action when a Devin session needs an OIDC token for a service that trusts Devin as an identity provider.

```yaml
initialize:
  - uses: github.com/CognitionAI/actions/setup-devin-oidc@main
```

After initialization, request a token for your service:

```bash
devin-oidc token --audience my-api
```

To include additional Devin identity claims in the token subject, pass their names as a space-delimited list:

```bash
devin-oidc token \
  --audience my-api \
  --subject-keys "org_id repository_name"
```

Your service must be configured to trust Devin as an OIDC identity provider and accept the requested audience.

See the [`setup-devin-oidc` action documentation](./setup-devin-oidc/README.md) for command options and configuration details.
