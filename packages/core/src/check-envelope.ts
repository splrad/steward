import { createHash } from "node:crypto";
const classificationCheckStateBodyBytes = 154;
const classificationCheckStateBytes = 186;
const classificationCheckStateEncodedLength = 248;
export function decodeClassificationCheckEnvelope(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("v4:")) return null;
  const encoded = value.slice(3);
  if (encoded.length !== classificationCheckStateEncodedLength || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return null;
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length !== classificationCheckStateBytes || decoded.toString("base64url") !== encoded || decoded[0] !== 4) return null;
  const checksum = createHash("sha256").update(decoded.subarray(0, classificationCheckStateBodyBytes)).digest();
  if (!checksum.equals(decoded.subarray(classificationCheckStateBodyBytes))) return null;
  const repositoryId = decoded.readUInt32BE(1);
  const pullRequestNumber = decoded.readUInt32BE(5);
  const headSha = decoded.subarray(9, 29).toString("hex");
  const policySha = decoded.subarray(133, 153).toString("hex");
  if (!repositoryId || !pullRequestNumber) return null;
  return { decoded, repositoryId, pullRequestNumber, headSha, policySha };
}
