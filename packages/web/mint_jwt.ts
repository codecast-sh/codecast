// Throwaway: mint a user JWT for diagnostics (delete after use).
import { SignJWT, importPKCS8 } from "/Users/ashot/src/codecast/node_modules/.bun/jose@5.10.0/node_modules/jose/dist/node/esm/index.js";

const USER_ID = "kd700q4pr2m98a3nghfesw4vxx7wkn6z";
const ISS = "https://convex.codecast.sh";

function normalizePem(raw: string): string {
  const body = raw
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
}

const key = await importPKCS8(normalizePem(process.env.JWT_PRIVATE_KEY!), "RS256");
const jwt = await new SignJWT({})
  .setProtectedHeader({ alg: "RS256" })
  .setSubject(`${USER_ID}|jh72nnwvdjk91b30zcsts7c99d8a8tvm`)
  .setIssuer(ISS)
  .setAudience("convex")
  .setIssuedAt()
  .setExpirationTime("2h")
  .sign(key);
console.log(jwt);
