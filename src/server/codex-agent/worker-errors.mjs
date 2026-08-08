export class CodexAgentWorkerError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'CodexAgentWorkerError';
    this.code = code;
    this.cause = cause;
  }
}

export const workerError = (code, message, cause = null) => new CodexAgentWorkerError(code, message, cause);

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

export const sanitizeAgentText = (value, projectRoot = '') => {
  let text = String(value ?? '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ');
  if (projectRoot) text = text.replace(new RegExp(escapeRegExp(projectRoot), 'giu'), '[project]');
  return text
    .replace(/\b(authorization\s*:\s*bearer)\s+[^\s]+/giu, '$1 [redacted]')
    .replace(/\b((?:openai[-_ ]?|codex[-_ ]?)?api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|credential|secret)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|]*/gu, '[path]')
    .replace(/(?:^|\s)\/(?:[^\s"'<>/]+\/)*[^\s"'<>/]*/gmu, (match) => `${match.startsWith(' ') ? ' ' : ''}[path]`)
    .replace(/\b(?:input|output|cached|reasoning)?_?tokens?\s*[:=]\s*\d+\b/giu, '[usage omitted]')
    .trim()
    .slice(0, 500);
};
