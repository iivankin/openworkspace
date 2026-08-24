const MAX_HEADER_BYTES = 256 * 1024;

function headerBlock(raw: string) {
  const separator = /\r?\n\r?\n/u.exec(raw);
  const end = separator?.index ?? raw.length;
  return raw.slice(0, Math.min(end, MAX_HEADER_BYTES));
}

export function originalHeaderValues(raw: string, name: string) {
  const unfolded = headerBlock(raw).replace(/\r?\n[\t ]+/gu, " ");
  const expected = name.toLocaleLowerCase();
  return unfolded.split(/\r?\n/gu).flatMap((line) => {
    const colon = line.indexOf(":");
    if (colon < 1 || line.slice(0, colon).trim().toLocaleLowerCase() !== expected) {
      return [];
    }
    const value = line.slice(colon + 1).trim();
    return value ? [value] : [];
  });
}

export function dkimSigningDomains(raw: string) {
  return [...new Set(originalHeaderValues(raw, "dkim-signature").flatMap(
    (signature) => {
      const domain = /(?:^|;)\s*d=([^;\s]+)/iu.exec(signature)?.[1];
      return domain ? [domain.toLocaleLowerCase()] : [];
    },
  ))];
}
