const MAX_ENCODED_DRAFT_LENGTH = 100_000;

export function decodeDraftParameter(search: string): unknown | null {
  try {
    const encoded = new URLSearchParams(search).get("draft");
    if (!encoded || encoded.length > MAX_ENCODED_DRAFT_LENGTH || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
      return null;
    }
    const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/")
      .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
