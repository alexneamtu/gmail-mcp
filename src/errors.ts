import {z} from 'zod';

const messages={
  invalid_arguments:'Check the command or tool arguments. Use --help for administration commands.',
  reauth_required:'This account requires enrollment. Run gmail-mcp-admin enroll <alias> with the selected account.',
  account_disabled:'This account is disabled pending removal. Retry remove <alias>, or deliberately re-enroll it to restore access.',
  identity_mismatch:'The stored identity differs from configuration. Restore the configuration or remove the old enrollment before changing identities.',
  scope_mismatch:'The mailbox grant does not cover the configured access mode. Re-enroll this alias and approve the requested Gmail permissions.',
  configuration_error:'Check the private configuration and imported OAuth clients. Use --help for setup instructions.',
  private_files_missing:'A required private file is missing. Check configuration/key paths and complete init before enrollment.',
  private_files_permissions:'A private file could not be opened. Check ownership, permissions and the selected admin command.',
  permission_denied:'Google denied access. Check granted Gmail scopes and Workspace administrator policy before re-enrolling.',
  not_found:'The message or draft was not found in this account. Search or check Gmail for its current ID.',
  quota_exceeded:'The Google Cloud project reached its daily Gmail API quota. Check project quotas or wait for the quota to reset; re-enrollment will not fix this.',
  rate_limited:'Google rate-limited this request. Wait before retrying; check Gmail before retrying any write.',
  upstream_unavailable:'Google could not complete this read or authorization request. Try again later.',
  write_outcome_unknown:'Gmail may have completed this write. Check its outcome in Gmail before retrying; do not retry automatically.',
  response_too_large:'The Gmail response exceeded the safety limit. Narrow the request or open this message in Gmail.',
  operation_failed:'Gmail operation failed. Check account status and arguments. Check Gmail before retrying a write; writes are never automatically retried.',
  wrong_account:'Select the expected Google account and start enrollment again. No enrollment was saved.',
  grant_missing:'Gmail permission or offline access was not granted. Start enrollment again and approve all requested permissions.',
  authorization_failed:'Google could not authorize this enrollment. Start again; check OAuth client configuration and permissions if it persists.',
  enrollment_cancelled:'Authorization was cancelled. Run enrollment again when ready.',
  enrollment_timeout:'Authorization timed out after ten minutes. Start enrollment again with the browser computer and SSH tunnel ready.',
  enrollment_port_busy:'Enrollment port 18888 is already in use. Finish the other enrollment or inspect that listener before retrying.',
  rotation_confirmation:'Stop the service and all admin processes, then pass --service-stopped to rotate-key.',
  rotation_backup_exists:'Key rotation recovery files already exist. Inspect and safely retire the matched backups before rotating again.',
  original_key_required:'Existing state requires its original encryption key. Restore a matched key/database pair; do not initialize a replacement key.',
} as const;
export type ErrorCode=keyof typeof messages;
export class OperationError extends Error {
  constructor(readonly code:ErrorCode){super(messages[code]);this.name='OperationError';}
}
export function safeError(error:unknown):{code:ErrorCode;message:string}{
  const code=error instanceof OperationError?error.code:error instanceof z.ZodError?'invalid_arguments':'operation_failed';
  return {code,message:messages[code]};
}
