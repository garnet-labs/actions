/**
 * Refreshes the Azure federated token file and, when needed, logs the Azure
 * CLI in with a fresh client assertion. The Azure SDKs consume the token file
 * through WorkloadIdentityCredential or DefaultAzureCredential.
 */
export function refreshScript(inputs: {
  clientId: string;
  tenantId: string;
  subscriptionId: string;
  audience: string;
  subjectKeys: string;
}): string {
  return `#!/usr/bin/env bash
set -euo pipefail

CLIENT_ID="${inputs.clientId}"
TENANT_ID="${inputs.tenantId}"
SUBSCRIPTION_ID="${inputs.subscriptionId}"
AUDIENCE="${inputs.audience}"
SUBJECT_KEYS="${inputs.subjectKeys}"
TOKEN_FILE="\${HOME:-/home/ubuntu}/.azure-federated-token"
MARKER="\${HOME:-/home/ubuntu}/.azure-oidc-login-stamp"
LOGIN_TTL=3000

die() { echo "devin-oidc-azure: $1" >&2; exit 1; }

jwt=$(devin-oidc token --audience "$AUDIENCE" --subject-keys "$SUBJECT_KEYS") \\
  || die "failed to obtain OIDC token from Devin"

printf '%s' "$jwt" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"

if [ "\${1:-}" != "--token-only" ]; then
  should_login=false
  if [ "\${1:-}" = "--force" ] || [ ! -f "$MARKER" ]; then
    should_login=true
  else
    age=$(( $(date +%s) - $(stat -c %Y "$MARKER" 2>/dev/null || echo 0) ))
    if [ "$age" -ge "$LOGIN_TTL" ]; then
      should_login=true
    fi
  fi

  if [ "$should_login" = true ] && [ -x /usr/local/bin/.az-real ]; then
    /usr/local/bin/.az-real login \\
      --service-principal \\
      --username "$CLIENT_ID" \\
      --tenant "$TENANT_ID" \\
      --federated-token "$jwt" \\
      --allow-no-subscriptions \\
      --output none \\
      || die "Azure CLI login failed"
    if [ -n "$SUBSCRIPTION_ID" ]; then
      /usr/local/bin/.az-real account set --subscription "$SUBSCRIPTION_ID" \\
        || die "Azure subscription selection failed"
    fi
    touch "$MARKER"
  fi
fi
`;
}

/**
 * Wrapper installed at /usr/local/bin/az. It refreshes the federated token
 * before ordinary Azure CLI commands while leaving login/logout/account
 * commands untouched so callers can use the native CLI behavior directly.
 */
export function wrapperScript(): string {
  return `#!/usr/bin/env bash
set -uo pipefail

REAL_AZ=/usr/local/bin/.az-real

case "\${1:-}" in
  login|logout|account)
    exec "$REAL_AZ" "$@"
    ;;
esac

/usr/local/bin/devin-oidc-azure-refresh >/dev/null 2>&1 || true
exec "$REAL_AZ" "$@"
`;
}

/**
 * Exec shim installed at /usr/local/bin/.az-real. The Debian az launcher
 * locates its Python runtime relative to its own path, so a symlink would
 * break it.
 */
export function realAzShimScript(azPath: string): string {
  return `#!/usr/bin/env bash\nexec "${azPath}" "$@"\n`;
}
