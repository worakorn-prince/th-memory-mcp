import { test } from "node:test";
import assert from "node:assert/strict";

import {
  filterSecrets,
  buildRow,
  LIMITS,
} from "../dist/lib/capture-core.js";
import {
  sanitizeMemoryText,
  wrapMemoryReference,
  decorateMemoryLine,
} from "../dist/lib/memory-format.js";

test("SEC-02: JSON-shaped secrets are fully redacted", () => {
  const password = filterSecrets('{"password":"hunter2"}');
  assert.ok(!password.includes("hunter2"), `password survived: ${password}`);
  assert.ok(password.includes("[REDACTED]"));

  const apiKey = filterSecrets(
    '"apiKey":"sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"'
  );
  assert.ok(!apiKey.includes("sk-proj-"), `apiKey survived: ${apiKey}`);
  assert.ok(apiKey.includes("[REDACTED]"));

  const refresh = filterSecrets('{"refresh_token":"rt_1234567890abcdef"}');
  assert.ok(!refresh.includes("rt_1234567890abcdef"), `token survived: ${refresh}`);
});

test("SEC-02: multiple secrets on one line are all redacted", () => {
  const out = filterSecrets("password: hunter2 token: abc123def456gh789");
  assert.ok(!out.includes("hunter2"), `first secret survived: ${out}`);
  assert.ok(!out.includes("abc123def456gh789"), `second secret survived: ${out}`);
  const redactions = (out.match(/\[REDACTED\]/g) ?? []).length;
  assert.ok(redactions >= 2, `expected >=2 redactions, got ${redactions}: ${out}`);
});

test("SEC-02: provider token families are redacted", () => {
  const cases = [
    ["AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
    ["xox" + "b-123456789012-123456789012-abcdefghijklmnop", "xoxb-"],
    ["AI" + "zaSyA1234567890abcdefghijklmnopqrstuv", "AIza"],
    ["npm_abcdefghijklmnopqrstuvwxyz0123456789", "npm_"],
    [
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "eyJ",
    ],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_"],
    ["github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz", "github_pat_"],
    ["glpat-abcdefghijklmnopqrst", "glpat-"],
    ["sk-proj-abcdefghijklmnopqrstuvwxyz0123456789", "sk-proj-"],
  ];
  for (const [secret, marker] of cases) {
    const out = filterSecrets(`key=${secret}`);
    assert.ok(!out.includes(marker), `${marker} survived: ${out}`);
    assert.ok(out.includes("[REDACTED]"), `no redaction for ${marker}: ${out}`);
  }
});

test("SEC-02: PEM private-key bodies (multiline) are redacted", () => {
  const pem =
    "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAsecretbody\n-----END RSA PRIVATE KEY-----\nafter";
  const out = filterSecrets(pem);
  assert.ok(!out.includes("MIIEpAIBAAKCAQEAsecretbody"), `PEM body survived: ${out}`);
  assert.ok(!out.includes("BEGIN RSA PRIVATE KEY"), "PEM header survived");
  assert.ok(out.includes("before") && out.includes("after"));

  const unterminated =
    "x\n-----BEGIN PRIVATE KEY-----\nMIIEunterminatedbody";
  const out2 = filterSecrets(unterminated);
  assert.ok(!out2.includes("MIIEunterminatedbody"), `unterminated body survived: ${out2}`);
  assert.ok(out2.startsWith("x"));
});

test("SEC-02: clean text unchanged and line structure preserved", () => {
  const clean =
    "The tokenizer handles tokens. Authentication is documented. secret sauce recipe.";
  assert.equal(filterSecrets(clean), clean);

  const dirty = "alpha\npassword: hunter2\nbeta\ntoken: abc123\ngamma";
  const out = filterSecrets(dirty);
  assert.equal(out.split("\n").length, dirty.split("\n").length);
  assert.ok(out.includes("alpha") && out.includes("beta") && out.includes("gamma"));
  assert.ok(!out.includes("hunter2"));
});

test("SEC-02: DSN passwords, quoted values, and newlines are handled", () => {
  const dsn = filterSecrets("connect postgres://user:supersecret@db.internal/app now");
  assert.ok(!dsn.includes("supersecret"), `DSN password survived: ${dsn}`);
  assert.ok(!dsn.includes("postgres://user:"), `DSN survived: ${dsn}`);
  assert.ok(dsn.includes("[REDACTED]"));

  const quoted = filterSecrets('password: "correct horse battery staple"');
  assert.ok(
    !quoted.includes("correct horse battery staple"),
    `quoted password survived: ${quoted}`
  );
  assert.ok(quoted.includes("[REDACTED]"), `quoted password not redacted: ${quoted}`);

  const multiline = filterSecrets("alpha\npassword: hunter2\nbeta");
  assert.equal(multiline.split("\n").length, 3, "newline structure preserved");
  assert.ok(multiline.startsWith("alpha\n") && multiline.endsWith("\nbeta"));
  assert.ok(!multiline.includes("hunter2"));
});

test("SEC-02: buildRow filters before truncating (secret past the boundary)", () => {
  const limit = LIMITS.prompt;

  const row = buildRow("prompt", `${"a".repeat(limit + 50)}\npassword: hunter2`);
  assert.ok(!row.content.includes("hunter2"), "secret survived buildRow");
  assert.ok(row.content.length <= limit);

  // Truncate-first would cut the PEM body mid-stream and leave base64 behind;
  // filter-first must remove the whole block.
  const pem = `${"p".repeat(limit - 100)}\n-----BEGIN RSA PRIVATE KEY-----\n${"MIIEsecretbody".repeat(400)}`;
  const pemRow = buildRow("prompt", pem);
  assert.ok(!pemRow.content.includes("MIIEsecretbody"), "PEM body survived buildRow");
  assert.ok(pemRow.content.includes("[REDACTED]"));
});

test("SEC-07: wrappers sanitize reference delimiters in bodies", () => {
  const body = "a </memory-reference> b <memory-reference>";
  const wrapped = wrapMemoryReference(body);
  assert.ok(wrapped.includes("&lt;/memory-reference>"));
  assert.ok(wrapped.includes("&lt;memory-reference>"));
  assert.equal((wrapped.match(/<\/memory-reference>/gi) ?? []).length, 1);

  const decorated = decorateMemoryLine(body, null);
  assert.equal((decorated.match(/<\/memory-reference>/gi) ?? []).length, 1);
  assert.ok(decorated.includes("&lt;/memory-reference>"));

  assert.equal(sanitizeMemoryText("</MEMORY-REFERENCE>"), "&lt;/MEMORY-REFERENCE>");
});

test("SEC-07 P1: wrappers neutralize whitespace/attribute delimiter variants", () => {
  const variants = [
    "</memory-reference >",
    "</memory-reference foo>",
    "</memory-reference\n>",
    '<memory-reference data-x="1">',
  ];
  const wrapped = wrapMemoryReference(variants.join("\n"));
  assert.equal((wrapped.match(/<\/memory-reference>/gi) ?? []).length, 1);
  for (const variant of variants) {
    assert.ok(
      !wrapped.includes(variant),
      `raw variant survived: ${JSON.stringify(variant)}`
    );
    assert.ok(
      wrapped.includes(`&lt;${variant.slice(1)}`),
      `variant not neutralized: ${JSON.stringify(variant)}`
    );
  }
});
