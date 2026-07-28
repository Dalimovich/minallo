export function isUuid(value: unknown): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

export function isSafeCourseId(value: unknown): boolean {
  return /^[a-zA-Z0-9._:-]{1,160}$/.test(String(value || ''));
}

export function isSafePdfStorageName(value: unknown): boolean {
  return /^[^<>:"\\|?*\x00-\x1F/]{1,220}\.pdf$/i.test(String(value || ''));
}

// Trims and enforces a max byte length. Returns the cleaned string or throws.
export function cleanText(value: unknown, maxLength: number): string {
  const str = String(value || '').trim();
  if (str.length > maxLength) throw new Error('Value exceeds maximum allowed length');
  return str;
}

// Ensures a value is one of the allowed set.
export function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], label?: string): T {
  if (!allowed.includes(value as T)) throw new Error((label || 'Value') + ' is not allowed');
  return value as T;
}
