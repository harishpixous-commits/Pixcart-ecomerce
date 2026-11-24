/** clsx: joins class names, skipping false, null, undefined and empty strings. */
export function cx(...parts: (string | false | null | undefined | 0)[]): string {
  return parts.filter(Boolean).join(" ");
}
