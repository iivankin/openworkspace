export class SamlError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 | 429 | 500 | 503 = 400,
  ) {
    super(message);
    this.name = "SamlError";
  }
}

export class SamlStatusError extends SamlError {
  constructor(
    message: string,
    readonly statusCode: string,
  ) {
    super(message);
    this.name = "SamlStatusError";
  }
}

export function samlError(error: unknown) {
  if (error instanceof SamlError) return error;
  console.error(error);
  return new SamlError("The SAML identity provider failed", 500);
}
