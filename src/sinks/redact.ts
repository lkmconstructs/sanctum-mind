/**
 * Removes credentials embedded in URLs (`scheme://user:pass@host`, `scheme://token@host`) from any text
 * before it is stored, logged or shown. Sink URLs are configured without userinfo, but an error message
 * can echo whatever a library or a hand-edited config produced, so every message passes through here.
 */
export function redactCredentials(text: string): string {
  return text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/?#@"'\\]+@/g, "$1***@");
}
