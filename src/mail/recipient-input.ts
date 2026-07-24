export type RecipientInputFields = {
  to: string[];
  cc: string[];
  bcc: string[];
};

function normalizeInputAddress(value: string) {
  const trimmed = value.trim();
  const separator = trimmed.lastIndexOf("@");
  if (separator <= 0 || separator === trimmed.length - 1) return trimmed;
  return `${trimmed.slice(0, separator)}@${trimmed.slice(separator + 1).toLocaleLowerCase("en-US")}`;
}

export function parseRecipientInput(value: string) {
  return value
    .split(/[;,]/u)
    .map(normalizeInputAddress)
    .filter(Boolean);
}

export function dedupeRecipientInputs(input: RecipientInputFields): RecipientInputFields {
  const seen = new Set<string>();
  const take = (values: string[]) => values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
  return {
    to: take(input.to),
    cc: take(input.cc),
    bcc: take(input.bcc),
  };
}

export function recipientInputCount(input: RecipientInputFields) {
  return input.to.length + input.cc.length + input.bcc.length;
}
