export function credentialHelperScript(inputs: {
  roleArn: string;
  audience: string;
  subjectKeys: string;
  sessionName: string;
  durationSeconds: string;
}): string {
  // The exchanged OIDC token is short-lived (~1 minute), so a static
  // web_identity_token_file would go stale. credential_process is re-run by
  // the AWS CLI/SDKs whenever the assumed-role credentials expire, fetching a
  // fresh token each time. AssumeRoleWithWebIdentity is unsigned, so the
  // helper needs no pre-existing AWS credentials. The inner call runs with an
  // empty config and no profile selection so it cannot recurse into (or fail
  // to resolve) the profile it is providing credentials for.
  return `#!/usr/bin/env bash
set -euo pipefail
token=$(devin-oidc token --audience "${inputs.audience}" --subject-keys "${inputs.subjectKeys}")
exec env -u AWS_PROFILE -u AWS_DEFAULT_PROFILE AWS_CONFIG_FILE=/dev/null aws sts assume-role-with-web-identity \\
  --role-arn "${inputs.roleArn}" \\
  --role-session-name "${inputs.sessionName}" \\
  --web-identity-token "$token" \\
  --duration-seconds ${inputs.durationSeconds} \\
  --query 'Credentials.{Version: \`1\`, AccessKeyId: AccessKeyId, SecretAccessKey: SecretAccessKey, SessionToken: SessionToken, Expiration: Expiration}' \\
  --output json
`;
}
