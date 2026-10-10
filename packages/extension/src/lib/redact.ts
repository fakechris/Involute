/**
 * Redaction in the browser (INV-1147): nothing that looks like a credential or
 * a person's address leaves the extension. It runs over everything the report
 * carries from the page — URLs (query and fragment values, path segments),
 * console messages, the picked element's text and the names it shows — before
 * the payload is assembled, so the server never sees the raw value.
 *
 * Over-redaction is the safe failure: a bug report loses a little context, a
 * leaked token is a security incident.
 */
export const REDACTED = '[redacted]';
export const REDACTED_EMAIL = '[email]';

/** Words that make a header, query or field name sensitive on their own. */
const SENSITIVE_WORDS = new Set([
  'apikey', 'auth', 'authorization', 'bearer', 'cookie', 'cookies', 'credential', 'credentials', 'csrf', 'jwt',
  'key', 'otp', 'pass', 'passwd', 'password', 'pin', 'pwd', 'secret', 'session', 'sessionid', 'sid', 'sig', 'signature',
  'ssn', 'token', 'xsrf',
]);
/** Substrings that make a name sensitive wherever they appear (accesstoken, x-api-key, set-cookie…). */
const SENSITIVE_PARTS = ['token', 'secret', 'password', 'passwd', 'session', 'cookie', 'auth', 'apikey', 'api_key', 'api-key', 'credential', 'private'];

/** In a URL, OAuth hands these over as query or fragment values; in prose they are ordinary words. */
const SENSITIVE_QUERY_NAMES = new Set(['code', 'state', 'nonce', 'ticket']);

/** Whether a header, query parameter or form/JSON field name may carry a secret. */
export function isSensitiveName(name: string, options: { query?: boolean } = {}): boolean {
  const lower = name.toLowerCase();
  if (options.query && SENSITIVE_QUERY_NAMES.has(lower)) return true;
  if (SENSITIVE_PARTS.some((part) => lower.includes(part))) return true;
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.some((word) => SENSITIVE_WORDS.has(word));
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
/** Stripe-style and service ids/keys: sk_live_…, pk_test_…, cus_…, whsec_…, ghp_…, xoxb-…, inv_ext_… */
const PREFIXED_ID = /\b(?:sk|pk|rk|cus|sub|acct|pi|seti|ch|in|price|prod|whsec|ghp|gho|ghu|ghs|github_pat|glpat|xox[abprs]|inv_ext|inv_agent|AKIA)[_-][A-Za-z0-9_-]{6,}/g;
/** Generic snake-prefixed opaque ids with a digit (abc_9f8Kd2…), as these services mint them. */
const OPAQUE_ID = /\b[a-z]{2,10}_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{10,}\b/g;
const LONG_HEX = /\b[0-9a-fA-F]{32,}\b/g;
/** Long base64/base64url runs that mix letters and digits: keys, not words. */
const LONG_BASE64 = /(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{32,}={0,2}/g;
/** Authorization schemes followed by their credential. */
const AUTH_SCHEME = /\b(Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
/**
 * `name=value`, `name: value`, `"name": "value"` where the name is sensitive.
 * The value runs to the next separator; quoted values to their closing quote.
 */
const NAMED_VALUE = /(["']?)([A-Za-z][A-Za-z0-9_.-]{1,60})\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&;,"'}\])]+)/g;

/** Whether a whole value (a path segment, a query value) looks like a secret or an address. */
export function looksSensitiveValue(value: string): boolean {
  const patterns = [EMAIL, JWT, PREFIXED_ID, OPAQUE_ID, LONG_HEX, LONG_BASE64];
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    const found = pattern.test(value);
    pattern.lastIndex = 0;
    return found;
  });
}

/** Redact secrets and addresses inside free text (console messages, element text, titles). */
export function redactText(input: string): string {
  let text = input;
  text = text.replace(AUTH_SCHEME, (_match, scheme: string) => `${scheme} ${REDACTED}`);
  text = text.replace(NAMED_VALUE, (match, quote: string, name: string, separator: string, value: string) => {
    if (!isSensitiveName(name)) return match;
    const open = value.startsWith('"') || value.startsWith("'") ? value[0] : '';
    return `${quote}${name}${quote}${separator}${open}${REDACTED}${open}`;
  });
  text = text.replace(JWT, REDACTED);
  text = text.replace(EMAIL, REDACTED_EMAIL);
  text = text.replace(PREFIXED_ID, REDACTED);
  text = text.replace(OPAQUE_ID, REDACTED);
  text = text.replace(LONG_HEX, REDACTED);
  text = text.replace(LONG_BASE64, REDACTED);
  // Redact URLs inside the text the same way as standalone ones.
  text = text.replace(/\bhttps?:\/\/[^\s"'<>]+/g, (url) => redactUrl(url));
  return text;
}

function redactParams(params: URLSearchParams): void {
  for (const [name, value] of [...params.entries()]) {
    if (isSensitiveName(name, { query: true })) params.set(name, REDACTED);
    else if (looksSensitiveValue(value)) params.set(name, REDACTED);
    else if (looksSensitiveValue(name)) {
      params.delete(name);
      params.append(REDACTED, '');
    }
  }
}

/**
 * Redact a URL: credentials in it are dropped, sensitive query and fragment
 * parameters are replaced, path segments that look like secrets or addresses
 * are replaced. A value that does not parse as a URL is redacted as text.
 */
export function redactUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return redactTextOnly(input);
  }
  url.username = '';
  url.password = '';
  url.pathname = url.pathname
    .split('/')
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        /* keep the raw segment */
      }
      return looksSensitiveValue(decoded) ? encodeURIComponent(REDACTED) : segment;
    })
    .join('/');
  if (url.search) {
    const params = new URLSearchParams(url.search);
    redactParams(params);
    url.search = params.toString();
  }
  if (url.hash) {
    const fragment = url.hash.slice(1);
    if (fragment.includes('=')) {
      const params = new URLSearchParams(fragment);
      redactParams(params);
      url.hash = params.toString();
    } else if (looksSensitiveValue(fragment)) {
      url.hash = REDACTED;
    }
  }
  return url.href;
}

/** redactText without the URL pass (used for a URL that did not parse, to avoid recursion). */
function redactTextOnly(input: string): string {
  return input
    .replace(AUTH_SCHEME, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(EMAIL, REDACTED_EMAIL)
    .replace(PREFIXED_ID, REDACTED)
    .replace(OPAQUE_ID, REDACTED)
    .replace(LONG_HEX, REDACTED)
    .replace(LONG_BASE64, REDACTED);
}

/** Header names that are never shown, whatever their value. */
export function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'authorization' || lower === 'proxy-authorization' || lower === 'cookie' || lower === 'set-cookie' || isSensitiveName(lower);
}
