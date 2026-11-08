// RFC 7303 §3.2: BOM > HTTP charset > XML declaration/autodetection > UTF-8.
export function decodeFeed(
  bytes: Uint8Array,
  contentType: string | null,
): string {
  const starts = (...values: number[]) =>
    values.every((v, i) => bytes[i] === v);
  if (
    starts(0x00, 0x00, 0xfe, 0xff) ||
    starts(0xff, 0xfe, 0x00, 0x00) ||
    starts(0x00, 0x00, 0x00, 0x3c) ||
    starts(0x3c, 0x00, 0x00, 0x00)
  )
    throw new Error("Unsupported feed encoding: UTF-32");
  const bom = starts(0xef, 0xbb, 0xbf)
    ? "utf-8"
    : starts(0xff, 0xfe)
      ? "utf-16le"
      : starts(0xfe, 0xff)
        ? "utf-16be"
        : undefined;
  const signature = starts(0x00, 0x3c)
    ? "utf-16be"
    : starts(0x3c, 0x00)
      ? "utf-16le"
      : undefined;
  const charset = contentType?.match(
    /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i,
  );
  const httpCharset = charset?.[1] ?? charset?.[2] ?? charset?.[3];
  const prefix = new TextDecoder(signature ?? "latin1").decode(
    bytes.subarray(0, 1024),
  );
  const declaration = prefix.match(
    /^\s*<\?xml\s[^?]*\bencoding\s*=\s*['"]([^'"]+)['"]/i,
  )?.[1];
  let encoding = (bom ?? httpCharset ?? declaration ?? signature ?? "utf-8")
    .trim()
    .toLowerCase();
  if (encoding === "utf-16" && signature) encoding = signature;
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(encoding, { fatal: true });
  } catch {
    throw new Error(`Unsupported feed encoding: ${encoding}`);
  }
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error(`Invalid feed bytes for encoding: ${encoding}`);
  }
}
