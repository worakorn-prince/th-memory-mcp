import { test } from "node:test";
import assert from "node:assert/strict";

const { ROLE_RANK, hasRole, TOOL_POLICY, canCallTool } = await import(
  "../dist/auth/policy.js"
);

// Canonical 16-tool surface with the approved minimum role and read/write kind.
const EXPECTED = {
  recall: { minRole: "reader", kind: "read" },
  get_profile: { minRole: "reader", kind: "read" },
  get_context: { minRole: "reader", kind: "read" },
  memory_stats: { minRole: "reader", kind: "read" },
  search_history: { minRole: "reader", kind: "read" },
  get_recent_interactions: { minRole: "reader", kind: "read" },
  remember: { minRole: "writer", kind: "write" },
  save_lesson: { minRole: "writer", kind: "write" },
  update_memory: { minRole: "writer", kind: "write" },
  link_memory: { minRole: "writer", kind: "write" },
  forget: { minRole: "owner", kind: "write" },
  merge_memory: { minRole: "owner", kind: "write" },
  consolidate: { minRole: "owner", kind: "write" },
  export_memory: { minRole: "owner", kind: "write" },
  import_memory: { minRole: "owner", kind: "write" },
  extract_memories: { minRole: "owner", kind: "write" },
};

const TOOLS = Object.keys(EXPECTED).sort();
const RANK = { reader: 0, writer: 1, owner: 2, admin: 3 };

function enforced(roles) {
  return { mode: "enforced", userId: "alice", uid: 1, roles };
}

test("ROLE_RANK is reader < writer < owner < admin", () => {
  assert.deepEqual(ROLE_RANK, { reader: 0, writer: 1, owner: 2, admin: 3 });
});

test("TOOL_POLICY covers exactly the 16 canonical tools", () => {
  assert.deepEqual(Object.keys(TOOL_POLICY).sort(), TOOLS);
  assert.equal(TOOLS.length, 16);
});

test("every policy entry has the approved minRole and kind", () => {
  for (const name of TOOLS) {
    assert.deepEqual(TOOL_POLICY[name], EXPECTED[name], `policy for ${name}`);
  }
});

test("canCallTool 16x4 matrix matches the minimum-role model", () => {
  let asserts = 0;
  for (const name of TOOLS) {
    const minRole = EXPECTED[name].minRole;
    for (const role of Object.keys(RANK)) {
      const expected = RANK[role] >= RANK[minRole];
      assert.equal(
        canCallTool(enforced([role]), name),
        expected,
        `${role} calling ${name} (minRole=${minRole})`
      );
      asserts++;
    }
  }
  assert.equal(asserts, 64);
});

test("enforced identity with no roles is denied on all 16 tools", () => {
  for (const name of TOOLS) {
    assert.equal(canCallTool(enforced([]), name), false, `${name} with roles=[]`);
  }
});

test("unknown tool names are denied (fail-closed)", () => {
  assert.equal(canCallTool(enforced(["admin"]), "not_a_tool"), false);
  assert.equal(canCallTool(enforced(["admin"]), ""), false);
  assert.equal(canCallTool(enforced(["admin"]), "remember "), false);
});

test("admin passes every minimum role, reader only reader-level tools", () => {
  for (const name of TOOLS) {
    assert.equal(canCallTool(enforced(["admin"]), name), true, `admin vs ${name}`);
  }
  const readerAllowed = TOOLS.filter((name) => canCallTool(enforced(["reader"]), name));
  assert.deepEqual(readerAllowed.sort(), TOOLS.filter((n) => EXPECTED[n].minRole === "reader"));
  assert.equal(readerAllowed.length, 6);
});

test("hasRole is rank-based and ignores unknown role strings", () => {
  assert.equal(hasRole(enforced(["admin"]), "admin"), true);
  assert.equal(hasRole(enforced(["admin"]), "owner"), true);
  assert.equal(hasRole(enforced(["admin"]), "writer"), true);
  assert.equal(hasRole(enforced(["admin"]), "reader"), true);
  assert.equal(hasRole(enforced(["owner"]), "admin"), false);
  assert.equal(hasRole(enforced(["owner"]), "writer"), true);
  assert.equal(hasRole(enforced(["writer"]), "owner"), false);
  assert.equal(hasRole(enforced(["reader"]), "writer"), false);
  assert.equal(hasRole(enforced(["reader"]), "reader"), true);
  assert.equal(hasRole(enforced(["superuser"]), "reader"), false);
  assert.equal(hasRole(enforced(["reader", "superuser"]), "reader"), true);
  assert.equal(hasRole(enforced([]), "reader"), false);
});
