/**
 * Authorization choke point (Ph-2 role gate + Ph-3 scope binding).
 *
 * Every MCP tool registration goes through `withAuth`, so there is exactly one
 * place where a call can be denied. Guarantees:
 *
 *  1. Structural default-deny at boot — a tool with no `TOOL_POLICY` entry
 *     throws at registration time, so an unpoliced tool can never be served.
 *  2. Legacy pass-through first — with `MEMORY_AUTH` off the wrapper calls the
 *     handler immediately (no identity work, no DB access, no audit rows),
 *     keeping behaviour byte-identical to v2.5.2.
 *  3. Enforced calls bind their scope from the verified identity *before* the
 *     handler runs (Ph-3), so a denied scope never reaches a repository.
 *
 * Every enforced decision is audited (allow + deny) with bounded, content-free
 * fields; the audit insert is best-effort and can never change a tool result.
 *
 * Deny runs before the handler, so a denied call has no side effects, and it
 * returns a bounded tool result (`isError: true`) instead of throwing an MCP
 * protocol error. The caller's own roles and the requested args are never
 * echoed.
 *
 * Ph-2 emitted a bounded stderr deny trail for role denies; Ph-3 replaces that
 * with the structured `audit_log` table. The stderr trail is removed.
 */
import { err, type ToolResult } from "../db/index.js";
import { recordDecision } from "../db/repositories/audit_log.js";
import { getIdentity, type AuthIdentity } from "./identity.js";
import { hasRole, TOOL_POLICY, type ToolPolicyEntry } from "./policy.js";
import {
  bindScopeToIdentity,
  describeScope,
  runWithScope,
  type ScopeAuditFields,
} from "./scope-resolver.js";

type AuthurableHandler = (...args: never[]) => unknown;

function deny(
  toolName: string,
  entry: ToolPolicyEntry,
  identity: AuthIdentity
): ToolResult {
  return err(`denied: ${toolName} requires role ${entry.minRole} (auth enforced)`);
}

function scopeDeny(toolName: string): ToolResult {
  return err(`denied: ${toolName} scope not permitted (auth enforced)`);
}

function asRecord(args: unknown): Record<string, unknown> {
  return args !== null && typeof args === "object"
    ? (args as Record<string, unknown>)
    : {};
}

/**
 * Which scope class the caller asked for (deny evidence only). Values are
 * identifiers, never content, and the audit repo bounds them again.
 */
function requestedScopeFields(args: Record<string, unknown>): ScopeAuditFields {
  if (typeof args.sessionId === "string" && args.sessionId.length > 0) {
    return { scopeKind: "SESSION", scopeRef: args.sessionId };
  }
  if (typeof args.projectId === "string" && args.projectId.length > 0) {
    return { scopeKind: "PROJECT", scopeRef: args.projectId };
  }
  if (typeof args.userId === "string" && args.userId.length > 0) {
    return { scopeKind: "USER", scopeRef: args.userId };
  }
  return { scopeKind: "GLOBAL", scopeRef: "*" };
}

/**
 * Wrap one tool handler with the role gate and the scope binding. The generated
 * dist/index.js keeps the wrapper's function type, so registration call sites
 * stay unchanged apart from the `withAuth("<name>", ...)` call itself.
 */
export function withAuth<F extends AuthurableHandler>(toolName: string, handler: F): F {
  const entry = TOOL_POLICY[toolName];
  if (entry === undefined) {
    throw new Error(
      `no TOOL_POLICY entry for "${toolName}": refusing to register an unpoliced tool`
    );
  }

  const wrapped = (args: unknown): ToolResult | Promise<ToolResult> => {
    const identity = getIdentity();
    if (identity.mode === "legacy") return handler(args as never) as ToolResult | Promise<ToolResult>;
    const record = asRecord(args);

    if (!hasRole(identity, entry.minRole)) {
      recordDecision({
        uid: identity.uid,
        tool: toolName,
        kind: entry.kind,
        decision: "deny",
        reason: "role",
        ...requestedScopeFields(record),
      });
      return deny(toolName, entry, identity);
    }

    const bound = bindScopeToIdentity(identity, record, toolName);
    if (!bound.ok) {
      recordDecision({
        uid: identity.uid,
        tool: toolName,
        kind: entry.kind,
        decision: "deny",
        reason: bound.reason,
        ...requestedScopeFields(record),
      });
      return scopeDeny(toolName);
    }

    const fields = describeScope(bound.scope);
    recordDecision({
      uid: identity.uid,
      tool: toolName,
      kind: entry.kind,
      decision: "allow",
      reason: null,
      scopeKind: fields.scopeKind,
      scopeRef: fields.scopeRef,
    });
    return runWithScope(bound.scope, () => handler(args as never) as ToolResult | Promise<ToolResult>);
  };

  return wrapped as unknown as F;
}
