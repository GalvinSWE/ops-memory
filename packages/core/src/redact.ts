/**
 * Redaction runs before any text reaches a model and before any quote is stored. A quote is
 * verified against the redacted text, so nothing redacted can come back in evidence.
 */
export type RedactionRule = 'email' | 'phone' | 'access_code' | 'url_token';

export interface RedactionOptions {
  rules: readonly RedactionRule[];
  /** Extra patterns, each replaced with `[REDACTED]`. Use the `g` flag. */
  patterns?: readonly RegExp[];
}

export const DEFAULT_REDACTION: RedactionOptions = {
  rules: ['email', 'phone', 'access_code', 'url_token']
};

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

// 7+ digits, allowing spaces, dots, dashes and brackets between them, with an optional leading +.
const PHONE = /(?<![\w])\+?\(?\d[\d\s().-]{5,}\d(?![\w])/g;

// "code 1234", "door code: 4821#", "lockbox is 0912", "PIN 7788", "password: hunter22", "wifi pw abc12345"
const ACCESS_CODE =
  /\b((?:(?:(?:door|gate|garage|lock ?box|keypad|building|amenit(?:y|ies)|access|entry|wifi|wi-fi|alarm)\s*)?(?:code|pin|passcode|password|pass|pw|combo|combination)s?|lock ?box|keypad)\s*(?:is|=|:|-)?\s*)([A-Za-z0-9#*]{3,12})(?![A-Za-z0-9#*])/gi;

// Dates and times look like phone numbers to the pattern above; they are not personal data.
const DATE_LIKE = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})([ T]\d{1,2}[:.]\d{2}([:.]\d{2})?)?$/;

// Query-string secrets in links: ?token=..., &key=..., &sig=...
const URL_TOKEN = /([?&](?:token|key|sig|signature|auth|access_token|code)=)[^&\s]+/gi;

export function redact(text: string, options: RedactionOptions = DEFAULT_REDACTION): string {
  let out = text;
  const rules = new Set(options.rules);
  if (rules.has('url_token')) out = out.replace(URL_TOKEN, '$1[REDACTED]');
  if (rules.has('email')) out = out.replace(EMAIL, '[REDACTED_EMAIL]');
  if (rules.has('access_code')) {
    out = out.replace(ACCESS_CODE, (match, lead: string, value: string) =>
      // "code is broken": a word, not a code. Only redact values that hold a digit or a symbol.
      /[\d#*]/.test(value) ? `${lead}[REDACTED_CODE]` : match
    );
  }
  if (rules.has('phone')) {
    out = out.replace(PHONE, (match) =>
      match.replace(/\D/g, '').length >= 7 && !DATE_LIKE.test(match.trim()) ? '[REDACTED_PHONE]' : match
    );
  }
  for (const pattern of options.patterns ?? []) out = out.replace(pattern, '[REDACTED]');
  return out;
}
