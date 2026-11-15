/**
 * Authorization choke point (Ph-2).
 *
 * Every MCP tool registration goes through `withAuth`, so there is exactly one
 * place where a call can be denied. Two guarantees:
 *
 *  1. Structural default-deny at boot — a tool with no `TOOL_POLICY` entry
 *     throws at registration time, so an unpoliced tool can never be served.
 *  2. Legacy pass-through first — with `MEMORY_AUTH` off the wrapper calls the
 *     handler immediately (no identity work, no DB access), keeping behaviour
 *     byte-identical to v2.5.2.
 *
 * Deny runs before the handler, so a denied call has no side effects, and it
 * returns a bounded tool result (`isError: true`) instead of throwing an MCP
 * protocol error. The caller's own roles are never echoed.
 */
import { err, type ToolResult } from "../db/index.js";
import { redactSecrets } from "../lib/redact.js";
import { getIdentity, type AuthIdentity } from "./identity.js";
import { hasRole, TOOL_POLICY, type ToolPolicyEntry } from "./policy.js";

type AuthurableHandler = (...args: never[]) => unknown;

const MAX_DENY_TRAIL = 240;

function writeDenyTrail(
  toolName: string,
  entry: ToolPolicyEntry,
  identity: AuthIdentity
): void {
  const user = identity.userId ?? "unknown";
  const raw = `[th-memory-mcp] authz: deny ${toolName} user=${user} needs=${entry.minRole}`;
  const line = redactSecrets(raw).replace(/[\r\n]+/g, " ").slice(0, MAX_DENY_TRAIL);
  process.stderr.write(`${line}\n`);
}

function deny(
  toolName: string,
  entry: ToolPolicyEntry,
  identity: AuthIdentity
): ToolResult {
  writeDenyTrail(toolName, entry, identity);
  return err(`denied: ${toolName} requires role ${entry.minRole} (auth enforced)`);
}

/**
 * Wrap one tool handler with the role gate. The generated dist/index.js keeps
 * the wrapper's function type, so registration call sites stay unchanged
 * apart from the `withAuth("<name>", ...)` call itself.
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
    if (!hasRole(identity, entry.minRole)) return deny(toolName, entry, identity);
    // Ph-3: bindScopeToIdentity(identity, args) — caller-supplied scope values
    // become checks, never authority (T1/T3).
    // Ph-3: audit(identity, toolName, entry.kind, "allow" | "deny", scope) —
    // replaces the interim stderr deny trail above.
    return handler(args as never) as ToolResult | Promise<ToolResult>;
  };

  return wrapped as unknown as F;
}
