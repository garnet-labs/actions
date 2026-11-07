/**
 * Shell script installed as the Vault token helper. On `get`, it exchanges a
 * Devin OIDC token for a Vault client token via the JWT auth method's login
 * endpoint and caches the result. On `store` / `erase`, it maintains the
 * cache so that `vault login` results are honoured.
 */
export function tokenHelperScript(inputs: {
  vaultAddr: string;
  role: string;
  authMount: string;
  audience: string;
  subjectKeys: string;
  vaultNamespace: string;
}): string {
  const nsHeader = inputs.vaultNamespace
    ? `  -H "X-Vault-Namespace: ${inputs.vaultNamespace}" \\\n`
    : "";
  return `#!/usr/bin/env bash
set -euo pipefail

# devin-oidc-vault-token-helper: Vault token helper that authenticates via
# Devin OIDC -> Vault JWT auth. Re-invoked by the vault CLI on each command.

VAULT_ADDR="${inputs.vaultAddr}"
ROLE="${inputs.role}"
AUTH_MOUNT="${inputs.authMount}"
AUDIENCE="${inputs.audience}"
SUBJECT_KEYS="${inputs.subjectKeys}"
CACHE_FILE="\${HOME:-/home/ubuntu}/.vault-token"
CACHE_TTL=300  # seconds — re-auth when cache is older than this

die() { echo "devin-oidc-vault: $1" >&2; exit 1; }

json_field() {
  printf '%s' "$1" | grep -o "\\"$2\\"[[:space:]]*:[[:space:]]*\\"[^\\"]*\\"" | head -1 | sed 's/.*:[[:space:]]*"\\(.*\\)"/\\1/'
}

do_login() {
  local jwt resp token errors
  jwt=$(devin-oidc token --audience "$AUDIENCE" --subject-keys "$SUBJECT_KEYS") \\
    || die "failed to obtain OIDC token"
  resp=$(curl -sS --connect-timeout 5 --max-time 30 \\
${nsHeader}    -X POST "$VAULT_ADDR/v1/auth/$AUTH_MOUNT/login" \\
    -d "{\\"role\\":\\"$ROLE\\",\\"jwt\\":\\"$jwt\\"}") \\
    || die "Vault login request failed"
  token=$(json_field "$resp" client_token)
  if [ -z "$token" ]; then
    errors=$(printf '%s' "$resp" | grep -o '"errors"[[:space:]]*:[[:space:]]*\\[[^]]*\\]' | head -1 || true)
    die "Vault login failed: \${errors:-$resp}"
  fi
  printf '%s' "$token" > "$CACHE_FILE"
  chmod 600 "$CACHE_FILE"
  printf '%s' "$token"
}

case "\${1:-}" in
  get)
    if [ -f "$CACHE_FILE" ]; then
      age=$(( $(date +%s) - $(stat -c %Y "$CACHE_FILE" 2>/dev/null || echo 0) ))
      if [ "$age" -lt "$CACHE_TTL" ]; then
        cat "$CACHE_FILE"
        exit 0
      fi
    fi
    do_login
    ;;
  store)
    read -r token || true
    if [ -n "\${token:-}" ]; then
      printf '%s' "$token" > "$CACHE_FILE"
      chmod 600 "$CACHE_FILE"
    fi
    ;;
  erase)
    rm -f "$CACHE_FILE"
    ;;
  *)
    echo "Usage: $0 {get|store|erase}" >&2
    exit 1
    ;;
esac
`;
}
