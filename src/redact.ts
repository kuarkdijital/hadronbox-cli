/**
 * Masks hadronbox API keys in any text the CLI itself prints (messages, JSON, debug lines). Output keeps the panel
 * display format `hb_live_••••<last4>` so a user can still tell keys apart. Remote command output (exec/sh) is user
 * data and is streamed without this filter.
 */
const API_KEY_PATTERN = /hb_live_[0-9A-Za-z]+/g;

/**
 * C0 controls, DEL, C1 controls (incl. 8-bit CSI 0x9B) and Unicode bidi overrides/isolates (U+202A–202E,
 * U+2066–2069) plus LRM/RLM/ALM. Text from the server or the command line must not be able to inject terminal
 * escape sequences or reorder what the user reads.
 */
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g;

export function redactSecrets(text: string): string {
  return text.replace(API_KEY_PATTERN, (match) => {
    const body = match.slice('hb_live_'.length);
    return body.length >= 8 ? `hb_live_••••${body.slice(-4)}` : 'hb_live_••••';
  });
}

/** Replaces every run of control/bidi characters with one space. */
export function stripControlChars(text: string): string {
  return text.replace(CONTROL_PATTERN, ' ');
}

/** Trims and bounds a server-provided message before it is shown, strips control characters and masks keys. */
export function sanitizeServerText(text: string, maxLength = 300): string {
  const singleLine = stripControlChars(text).trim();
  const bounded = singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 1)}…` : singleLine;
  return redactSecrets(bounded);
}

/**
 * `https://user:pass@host` → `https://***@host`, also for strings that do not parse as a URL. Greedy up to the last
 * `@` of the authority (the WHATWG separator), so a password containing `@` is masked completely.
 */
export function maskUrlCredentials(raw: string): string {
  return raw.replace(/(\/\/)[^/?#\s]*@/g, '$1***@');
}
