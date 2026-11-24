/** Decodes a URI component from the address bar, or returns the raw string when the percent sequence is malformed. */
export function decodePart(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}
