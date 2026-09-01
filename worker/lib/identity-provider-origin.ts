type IdentityProviderOriginBindings = {
  IDENTITY_PROVIDER_ORIGIN?: string;
  ALLOW_MOCK_AUTH?: string;
};

export class IdentityProviderOriginError extends Error {
  constructor(
    readonly reason: "missing" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "IdentityProviderOriginError";
  }
}

export function identityProviderOrigin(env: IdentityProviderOriginBindings) {
  const configured = env.IDENTITY_PROVIDER_ORIGIN?.trim();
  if (!configured) {
    throw new IdentityProviderOriginError(
      "missing",
      "Identity provider origin is not configured",
    );
  }

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new IdentityProviderOriginError(
      "invalid",
      "Identity provider origin is invalid",
    );
  }
  const allowedProtocol = url.protocol === "https:"
    || (url.protocol === "http:" && env.ALLOW_MOCK_AUTH === "true");
  if (
    url.search
    || url.hash
    || url.pathname !== "/"
    || url.username
    || url.password
    || !allowedProtocol
  ) {
    throw new IdentityProviderOriginError(
      "invalid",
      "Identity provider origin must be an HTTPS origin without a path",
    );
  }
  return url.origin;
}
