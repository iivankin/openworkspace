import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
} from "jose";

const { privateKey } = await generateKeyPair("RS256", {
  extractable: true,
  modulusLength: 2048,
});
const privateJwk = await exportJWK(privateKey);
const kid = await calculateJwkThumbprint(privateJwk);

console.log("Set this JSON as the OIDC_SIGNING_PRIVATE_JWK Worker secret:\n");
console.log(JSON.stringify({
  ...privateJwk,
  alg: "RS256",
  use: "sig",
  kid,
}));
