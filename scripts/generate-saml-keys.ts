import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const outputDirectory = resolve(".saml");
const privateKeyPath = resolve(outputDirectory, "private-key.pem");
const certificatePath = resolve(outputDirectory, "certificate.pem");

if (existsSync(privateKeyPath) || existsSync(certificatePath)) {
  throw new Error(".saml already contains signing material; move it before rotating keys");
}

mkdirSync(outputDirectory, { recursive: true });
execFileSync("openssl", [
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-sha256",
  "-nodes",
  "-days",
  "3650",
  "-subj",
  "/CN=OpenWorkspace SAML",
  "-keyout",
  privateKeyPath,
  "-out",
  certificatePath,
], { stdio: "inherit" });

console.log("\nGenerated .saml/private-key.pem and .saml/certificate.pem");
console.log("wrangler secret put SAML_SIGNING_PRIVATE_KEY < .saml/private-key.pem");
console.log("wrangler secret put SAML_SIGNING_CERTIFICATE < .saml/certificate.pem");
