export type PublicSurface = 'github' | 'linear';

export interface SafetyFinding {
  code: 'local_absolute_path' | 'secret_keyword' | 'private_key_block' | 'bearer_token' | 'credential_value';
  message: string;
  index: number;
}

export interface SafetyScanResult {
  ok: boolean;
  findings: SafetyFinding[];
}

export interface SafetyScanOptions {
  surface: PublicSurface;
  allowLocalPaths?: boolean;
}

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu;
const AUTH_BEARER = /(Authorization:\s*Bearer\s+)([^\s"'`]+)/giu;
const CREDENTIAL_KV = /\b(api[_-]?key|token|secret|password)\b(\s*[:=]\s*)([^\s&"'`]+)/giu;
const TOKEN_QUERY = /\b(token=)([^\s&"'`]+)/giu;
const LOCAL_PATH = /(?:\/(?:Users|home|tmp|var|private|opt|Volumes)\/[^\s)\]"']+|[A-Za-z]:\\(?:Users|Temp|tmp)\\[^\s)\]"']+)/gu;
const SECRET_KEYWORD = /\b(api[_-]?key|token|secret|password|Authorization:|Bearer\s+)\b/iu;

export function redactText(input: string): string {
  return input
    .replace(PRIVATE_KEY_BLOCK, '[REDACTED_PRIVATE_KEY]')
    .replace(AUTH_BEARER, '$1[REDACTED]')
    .replace(CREDENTIAL_KV, '$1$2[REDACTED]')
    .replace(TOKEN_QUERY, '$1[REDACTED]');
}

export function redactShareableText(input: string): string {
  return redactLocalPaths(redactText(input));
}

export function scanPublicContent(input: string, opts: SafetyScanOptions): SafetyScanResult {
  const findings: SafetyFinding[] = [];
  collectRegex(input, PRIVATE_KEY_BLOCK, findings, 'private_key_block', 'Private key block is not safe for publication');
  collectRegex(input, AUTH_BEARER, findings, 'bearer_token', 'Bearer token is not safe for publication');
  collectRegex(input, CREDENTIAL_KV, findings, 'credential_value', 'Credential-looking key/value is not safe for publication');

  if (!(opts.surface === 'linear' && opts.allowLocalPaths === true)) {
    collectRegex(input, LOCAL_PATH, findings, 'local_absolute_path', 'Local absolute paths are not safe for this surface');
  }

  const redacted = redactText(input);
  const keywordMatch = SECRET_KEYWORD.exec(redacted);
  if (keywordMatch) {
    findings.push({ code: 'secret_keyword', message: 'Secret-related keyword remains after redaction', index: keywordMatch.index });
  }

  return { ok: findings.length === 0, findings };
}

function collectRegex(input: string, regex: RegExp, findings: SafetyFinding[], code: SafetyFinding['code'], message: string): void {
  regex.lastIndex = 0;
  for (const match of input.matchAll(regex)) {
    const index = match.index ?? 0;
    if (code === 'local_absolute_path' && isUrlPathMatch(input, index)) continue;
    findings.push({ code, message, index });
  }
}

function redactLocalPaths(input: string): string {
  LOCAL_PATH.lastIndex = 0;
  return input.replace(LOCAL_PATH, (match, ...args: unknown[]) => {
    const index = typeof args[args.length - 2] === 'number' ? (args[args.length - 2] as number) : 0;
    return isUrlPathMatch(input, index) ? match : '[REDACTED_LOCAL_PATH]';
  });
}

function isUrlPathMatch(input: string, matchIndex: number): boolean {
  const prefix = input.slice(0, matchIndex);
  return /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/]+$/u.test(prefix);
}
