/**
 * Shell script installed as the executable credential source for GCP
 * Workload Identity Federation. Re-invoked by gcloud/Google SDKs whenever a
 * fresh subject token is needed; the exchanged Devin OIDC token is
 * short-lived, so a static credential file would go stale.
 */
export function credentialHelperScript(inputs: {
  audience: string;
  subjectKeys: string;
}): string {
  return `#!/usr/bin/env bash
set -euo pipefail

# devin-oidc-gcp-token-helper: executable credential source for GCP Workload
# Identity Federation. Prints the executable-sourced credential JSON expected
# by gcloud and the Google Cloud client libraries.

AUDIENCE="${inputs.audience}"
SUBJECT_KEYS="${inputs.subjectKeys}"

die() { echo "devin-oidc-gcp: $1" >&2; exit 1; }

b64url_decode() {
  local s="\${1//-/+}"
  s="\${s//_//}"
  while [ $((\${#s} % 4)) -ne 0 ]; do s="$s="; done
  printf '%s' "$s" | base64 -d
}

token=$(devin-oidc token --audience "$AUDIENCE" --subject-keys "$SUBJECT_KEYS") \\
  || die "failed to obtain OIDC token"

payload=$(b64url_decode "$(printf '%s' "$token" | cut -d. -f2)")
exp=$(printf '%s' "$payload" | grep -o '"exp"[[:space:]]*:[[:space:]]*[0-9]*' | head -1 | grep -o '[0-9]*$')
[ -n "$exp" ] || die "could not read exp claim from the exchanged token"

printf '{"version":1,"success":true,"token_type":"urn:ietf:params:oauth:token-type:jwt","id_token":"%s","expiration_time":%s}' "$token" "$exp"
`;
}
