/**
 * RBAC policy (Ph-2).
 *
 * Minimum-role model: `admin` ⊇ `owner` ⊇ `writer` ⊇ `reader`. Each of the 16
 * MCP tools has exactly one policy entry, and the guard refuses to register a
 * tool that has none (structural default-deny — see src/auth/guard.ts).
 *
 * `kind` is informational in Ph-2 (every deny is identical); Ph-3's audit rows
 * use it to classify read/write without re-deciding the policy.
 *
 * Note: `canCallTool` answers the enforced-mode question only. The guard checks
 * `identity.mode === "legacy"` first and returns a pass-through, so a legacy
 * identity (whose `roles` is `[]`) is never asked here — and if it were, it
 * would be denied (fail-closed, never fail-open).
 */
import type { AuthIdentity, Role } from "./identity.js";

export const ROLE_RANK: Record<Role, number> = {
  reader: 0,
  writer: 1,
  owner: 2,
  admin: 3,
};

function rankOf(role: string): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(ROLE_RANK, role)) return undefined;
  return ROLE_RANK[role as Role];
}

/** True when any of the identity's roles outranks (or matches) `minRole`. */
export function hasRole(identity: AuthIdentity, minRole: Role): boolean {
  const min = ROLE_RANK[minRole];
  return identity.roles.some((role) => {
    const rank = rankOf(role);
    return rank !== undefined && rank >= min;
  });
}

export interface ToolPolicyEntry {
  minRole: Role;
  kind: "read" | "write";
}

export const TOOL_POLICY: Record<string, ToolPolicyEntry> = {
  // 6 read tools — any authenticated role.
  recall: { minRole: "reader", kind: "read" },
  get_profile: { minRole: "reader", kind: "read" },
  get_context: { minRole: "reader", kind: "read" },
  memory_stats: { minRole: "reader", kind: "read" },
  search_history: { minRole: "reader", kind: "read" },
  get_recent_interactions: { minRole: "reader", kind: "read" },
  // 4 additive write tools.
  remember: { minRole: "writer", kind: "write" },
  save_lesson: { minRole: "writer", kind: "write" },
  update_memory: { minRole: "writer", kind: "write" },
  link_memory: { minRole: "writer", kind: "write" },
  // 6 destructive/blast-radius tools.
  forget: { minRole: "owner", kind: "write" },
  merge_memory: { minRole: "owner", kind: "write" },
  consolidate: { minRole: "owner", kind: "write" },
  export_memory: { minRole: "owner", kind: "write" },
  import_memory: { minRole: "owner", kind: "write" },
  extract_memories: { minRole: "owner", kind: "write" },
};

/** Unknown (unpoliced) tool or an identity with no usable role → false. */
export function canCallTool(identity: AuthIdentity, toolName: string): boolean {
  const entry = TOOL_POLICY[toolName];
  if (entry === undefined) return false;
  return hasRole(identity, entry.minRole);
}
