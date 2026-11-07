/**
 * Shell script that exchanges a Devin OIDC token for an Infisical access
 * token via the OIDC Auth login endpoint and caches the result. Called by
 * the infisical wrapper, or directly via `devin-oidc-infisical-refresh`.
 */
export function refreshScript(inputs: {
  infisicalUrl: string;
  identityId: string;
  audience: string;
  subjectKeys: string;
}): string {
  return `#!/usr/bin/env bash
set -euo pipefail

INFISICAL_URL="${inputs.infisicalUrl}"
IDENTITY_ID="${inputs.identityId}"
AUDIENCE="${inputs.audience}"
SUBJECT_KEYS="${inputs.subjectKeys}"
CACHE_FILE="\${HOME:-/home/ubuntu}/.infisical-oidc-token"
CACHE_TTL=3600  # seconds — re-auth when cache is older than this

die() { echo "devin-oidc-infisical: $1" >&2; exit 1; }

json_field() {
  printf '%s' "$1" | grep -o "\\"$2\\"[[:space:]]*:[[:space:]]*\\"[^\\"]*\\"" | head -1 | sed 's/.*:[[:space:]]*"\\(.*\\)"/\\1/'
}

if [ "\${1:-}" != "--force" ] && [ -f "$CACHE_FILE" ]; then
  age=$(( $(date +%s) - $(stat -c %Y "$CACHE_FILE" 2>/dev/null || echo 0) ))
  if [ "$age" -lt "$CACHE_TTL" ]; then
    cat "$CACHE_FILE"
    exit 0
  fi
fi

# 1. Get audience-scoped OIDC token from Devin
jwt=$(devin-oidc token --audience "$AUDIENCE" --subject-keys "$SUBJECT_KEYS") \\
  || die "failed to obtain OIDC token from Devin"

# 2. Exchange for Infisical access token via OIDC Auth login
resp=$(curl -sS --connect-timeout 5 --max-time 30 \\
  -X POST "$INFISICAL_URL/api/v1/auth/oidc-auth/login" \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  --data-urlencode "identityId=$IDENTITY_ID" \\
  --data-urlencode "jwt=$jwt") \\
  || die "Infisical OIDC login request failed"

token=$(json_field "$resp" accessToken)
[ -n "$token" ] || die "Infisical OIDC login failed: $resp"

printf '%s' "$token" > "$CACHE_FILE"
chmod 600 "$CACHE_FILE"
printf '%s' "$token"
`;
}

/**
 * Wrapper script installed at /usr/local/bin/infisical. Obtains an access
 * token via the refresh helper and delegates to the real infisical binary
 * with INFISICAL_TOKEN set, so commands authenticate automatically.
 */
export function wrapperScript(): string {
  return `#!/usr/bin/env bash
set -uo pipefail

REAL_INFISICAL=/usr/local/bin/.infisical-real

# Respect an explicitly provided token
if [ -n "\${INFISICAL_TOKEN:-}" ]; then
  exec "$REAL_INFISICAL" "$@"
fi

token=$(/usr/local/bin/devin-oidc-infisical-refresh 2>/dev/null || true)
if [ -n "$token" ]; then
  INFISICAL_TOKEN="$token" exec "$REAL_INFISICAL" "$@"
fi

# Refresh failed — run without a token so login/debug commands still work
exec "$REAL_INFISICAL" "$@"
`;
}
