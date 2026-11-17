/**
 * Shell script that exchanges a Devin OIDC token for a JFrog access token
 * and updates the jf CLI config. Called by the jf wrapper on auth failure,
 * or directly via `devin-oidc-jfrog-refresh`.
 */
export function refreshScript(inputs: {
  jfrogUrl: string;
  providerName: string;
  audience: string;
  subjectKeys: string;
  serverId: string;
}): string {
  return `#!/usr/bin/env bash
set -euo pipefail

JFROG_URL="${inputs.jfrogUrl}"
PROVIDER_NAME="${inputs.providerName}"
AUDIENCE="${inputs.audience}"
SUBJECT_KEYS="${inputs.subjectKeys}"
SERVER_ID="${inputs.serverId}"

die() { echo "devin-oidc-jfrog: $1" >&2; exit 1; }

json_field() {
  printf '%s' "$1" | grep -o "\\"$2\\"[[:space:]]*:[[:space:]]*\\"[^\\"]*\\"" | head -1 | sed 's/.*:[[:space:]]*"\\(.*\\)"/\\1/'
}

# 1. Get audience-scoped OIDC token from Devin
jwt=$(devin-oidc token --audience "$AUDIENCE" --subject-keys "$SUBJECT_KEYS") \\
  || die "failed to obtain OIDC token from Devin"

# 2. Exchange for JFrog access token
resp=$(curl -sS --connect-timeout 5 --max-time 30 \\
  -X POST "$JFROG_URL/access/api/v1/oidc/token" \\
  -H "Content-Type: application/json" \\
  -d "{\\"grant_type\\":\\"urn:ietf:params:oauth:grant-type:token-exchange\\",\\"subject_token_type\\":\\"urn:ietf:params:oauth:token-type:id_token\\",\\"subject_token\\":\\"$jwt\\",\\"provider_name\\":\\"$PROVIDER_NAME\\"}") \\
  || die "JFrog token exchange request failed"

token=$(json_field "$resp" access_token)
[ -n "$token" ] || die "JFrog token exchange failed: $resp"

# 3. Update jf CLI config
/usr/local/bin/.jf-real config add "$SERVER_ID" \\
  --url="$JFROG_URL" \\
  --access-token="$token" \\
  --interactive=false \\
  --overwrite 2>/dev/null

printf '%s' "$token"
`;
}

/**
 * Wrapper script installed at /usr/local/bin/jf. Delegates to the real jf
 * binary and retries once after refreshing credentials on auth failure.
 */
export function wrapperScript(): string {
  return `#!/usr/bin/env bash
set -uo pipefail

REAL_JF=/usr/local/bin/.jf-real

# Capture stdout and stderr separately to preserve fd separation
stdout_file=$(mktemp)
stderr_file=$(mktemp)
cleanup() { rm -f "$stdout_file" "$stderr_file"; }
trap cleanup EXIT

"$REAL_JF" "$@" >"$stdout_file" 2>"$stderr_file"
rc=$?

if [ $rc -eq 0 ]; then
  cat "$stdout_file"
  cat "$stderr_file" >&2
  exit 0
fi

# Check if failure is auth-related (check both stdout and stderr)
if grep -qiE '401|403|unauthorized|forbidden|token.*expir|credentials.*invalid' "$stdout_file" "$stderr_file" 2>/dev/null; then
  # Attempt token refresh
  if /usr/local/bin/devin-oidc-jfrog-refresh >/dev/null 2>&1; then
    # Retry with fresh credentials — exec preserves fd separation naturally
    exec "$REAL_JF" "$@"
  fi
fi

# Not auth-related or refresh failed — replay original output to correct fds
cat "$stdout_file"
cat "$stderr_file" >&2
exit $rc
`;
}
