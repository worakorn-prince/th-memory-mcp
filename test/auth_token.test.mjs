import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

const {
  generateToken,
  hashToken,
  verifyToken,
  isValidTokenFormat,
  isValidUserId,
  hashPrefix,
} = await import("../dist/auth/token.js");
const { filterSecrets } = await import("../dist/lib/capture-core.js");
const { redactSecrets } = await import("../dist/lib/redact.js");

const SHA256_HEX = /^[0-9a-f]{64}$/;

test("generateToken produces the frozen thm_<userId>_<43> format", () => {
  const token = generateToken("alice");
  assert.match(token, /^thm_alice_[A-Za-z0-9_-]{43}$/);
  assert.ok(isValidTokenFormat(token), `should validate: ${token}`);
  assert.equal(token.length, "thm_".length + "alice".length + 1 + 43);
});

test("generateToken is unique per call and rejects invalid userIds", () => {
  const a = generateToken("bob");
  const b = generateToken("bob");
  assert.notEqual(a, b, "random suffixes must differ");
  assert.throws(() => generateToken(""), /1-200/);
  assert.throws(() => generateToken("x".repeat(201)), /1-200/);
  assert.throws(() => generateToken("bad\nid"), /control/);
});

test("hashToken is stable sha256 hex and never returns the token", () => {
  const token = generateToken("carol");
  const h1 = hashToken(token);
  const h2 = hashToken(token);
  assert.equal(h1, h2, "hash must be deterministic");
  assert.match(h1, SHA256_HEX);
  assert.notEqual(h1, token);
  assert.equal(
    h1,
    createHash("sha256").update(token, "utf8").digest("hex"),
    "must be plain sha256 (high-entropy secret, no KDF)"
  );
});

test("verifyToken accepts the matching token only", () => {
  const token = generateToken("dave");
  const stored = hashToken(token);
  assert.equal(verifyToken(token, stored), true);
  assert.equal(verifyToken(generateToken("dave"), stored), false);
  assert.equal(verifyToken(token, hashToken(generateToken("dave"))), false);
});

test("verifyToken normalizes stored hash casing and rejects malformed input", () => {
  const token = generateToken("erin");
  const stored = hashToken(token);
  assert.equal(verifyToken(token, stored.toUpperCase()), true);
  assert.equal(verifyToken(token, "not-a-hash"), false);
  assert.equal(verifyToken(token, ""), false);
  assert.equal(verifyToken("thm_erin_short", stored), false);
  assert.equal(verifyToken("", stored), false);
  assert.equal(verifyToken(undefined, stored), false);
  assert.equal(verifyToken(token, undefined), false);
});

test("token format validation is strict", () => {
  const good = `thm_frank_${randomBytes(32).toString("base64url")}`;
  assert.equal(isValidTokenFormat(good), true);

  assert.equal(isValidTokenFormat(`thm_frank_${"a".repeat(42)}`), false, "too short");
  assert.equal(isValidTokenFormat(`thm_frank_${"a".repeat(44)}`), false, "too long");
  assert.equal(isValidTokenFormat(`THM_frank_${"a".repeat(43)}`), false, "prefix");
  assert.equal(isValidTokenFormat(`thm__${"a".repeat(43)}`), false, "empty user");
  assert.equal(isValidTokenFormat(`thm_bad\x01id_${"a".repeat(43)}`), false, "control char");
  assert.equal(isValidTokenFormat(`thm_${"u".repeat(201)}_${"a".repeat(43)}`), false, "user > 200");
  assert.equal(isValidTokenFormat("thm_only"), false);
  assert.equal(isValidTokenFormat(""), false);
});

test("isValidUserId mirrors ensureUser constraints", () => {
  assert.equal(isValidUserId("a"), true);
  assert.equal(isValidUserId("x".repeat(200)), true);
  assert.equal(isValidUserId(""), false);
  assert.equal(isValidUserId("x".repeat(201)), false);
  assert.equal(isValidUserId("tab\there"), false);
});

test("hashPrefix exposes only a short display prefix", () => {
  const h = hashToken(generateToken("gina"));
  assert.equal(hashPrefix(h), h.slice(0, 12));
  assert.equal(hashPrefix(h, 6), h.slice(0, 6));
  assert.ok(!hashPrefix(h).includes("gina"));
});

test("redactSecrets/filterSecrets redact thm_ tokens but leave thm_config prose", () => {
  const token = generateToken("alice");
  assert.match(token, /^thm_alice_[A-Za-z0-9_-]{43}$/);
  assert.equal(redactSecrets(token), "[REDACTED]");
  assert.equal(filterSecrets(`keep ${token} safe`), "keep [REDACTED] safe");

  const manual = `thm_bob_${"a".repeat(43)}`;
  assert.equal(redactSecrets(manual), "[REDACTED]");

  assert.equal(filterSecrets("thm_config"), "thm_config");
  assert.equal(
    filterSecrets("the thm_config setting controls redaction"),
    "the thm_config setting controls redaction"
  );
  assert.equal(filterSecrets("thm_short"), "thm_short");
  const real = generateToken("carol");
  assert.equal(
    filterSecrets(`contact thm_config before rotating ${real}`),
    "contact thm_config before rotating [REDACTED]"
  );
});
