import { err, ok } from "../../db/index.js";
import { generateToken, hashPrefix, hashToken } from "../../auth/token.js";
import { fail, optStr, optInt, output, type CliOpts, type Globals } from "./shared.js";

const ROLE_VALUES = ["reader", "writer", "owner", "admin"];
const MIN_HASH_PREFIX = 6;
const MAX_NAME_LENGTH = 100;
const BACKFILL_BATCH_SIZE = 500;

// Keep TSV rows single-line and revoke-by-label unambiguous: strip control
// characters and cap length before anything is stored.
function sanitizeName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, MAX_NAME_LENGTH);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * th-memory auth <add-user|issue-token|list|revoke> — local admin CLI.
 *
 * Bootstrap order: run these WITHOUT MEMORY_AUTH=on (local admin, same DB).
 * This is the only path that creates users/tokens; the server never mints.
 * The token plaintext is printed exactly once, by `issue-token`.
 */
export async function runAuth(opts: CliOpts, pos: string[], g: Globals): Promise<number> {
  const { insertAuthToken, listTokens, revokeByHash } = await import(
    "../../db/repositories/auth_tokens.js"
  );
  const { ensureUser, getUserByExternalId, listUsers, setUserRole } = await import(
    "../../db/repositories/users.js"
  );

  const sub = pos[0];
  if (sub === undefined) fail("auth requires <add-user|issue-token|list|revoke> (see help)", g.json);

  const roleArg = optStr(opts, "--role");
  if (roleArg !== undefined && !ROLE_VALUES.includes(roleArg)) {
    fail(`--role must be ${ROLE_VALUES.join("|")} (got "${roleArg}")`, g.json);
  }

  switch (sub) {
    case "add-user": {
      const externalId = pos[1];
      if (externalId === undefined) fail("auth add-user requires <userId>", g.json);
      const name = sanitizeName(optStr(opts, "--name"));
      try {
        const existing = getUserByExternalId(externalId);
        if (existing !== undefined) {
          if (roleArg !== undefined) setUserRole(externalId, roleArg);
          return output(
            ok(
              `auth: user ${externalId} already exists (role=${roleArg ?? existing.role})`
            ),
            g
          );
        }
        ensureUser(externalId, name);
        if (roleArg !== undefined) setUserRole(externalId, roleArg);
        return output(ok(`auth: added user ${externalId} (role=${roleArg ?? "reader"})`), g);
      } catch (e) {
        return output(err(e instanceof Error ? e.message : String(e)), g);
      }
    }

    case "issue-token": {
      const externalId = pos[1];
      if (externalId === undefined) fail("auth issue-token requires <userId>", g.json);
      const label = sanitizeName(optStr(opts, "--label"));
      try {
        const user = getUserByExternalId(externalId);
        if (user === undefined) {
          return output(err(`unknown user "${externalId}" (run: th-memory auth add-user ${externalId})`), g);
        }
        const token = generateToken(externalId);
        insertAuthToken(hashToken(token), user.id, label ?? null);
        // The one and only plaintext print: stdout, once.
        return output(ok(token), g);
      } catch (e) {
        return output(err(e instanceof Error ? e.message : String(e)), g);
      }
    }

    case "list":
    case "ls": {
      try {
        const users = listUsers();
        const tokens = listTokens();
        if (g.json) {
          const safeTokens = tokens.map((t) => ({
            external_id: t.external_id,
            role: t.role,
            label: t.label,
            hash_prefix: hashPrefix(t.token_hash),
            created_at: t.created_at,
            revoked: !!t.revoked_at,
          }));
          return output(ok(JSON.stringify({ users, tokens: safeTokens })), g);
        }
        const lines: string[] = [];
        for (const u of users) lines.push(`user\t${u.external_id}\t${u.role}`);
        if (tokens.length === 0) {
          lines.push("(no auth tokens)");
        } else {
          for (const t of tokens) {
            lines.push(
              `token\t${t.external_id}\t${t.role}\t${t.label ?? "-"}\t${hashPrefix(t.token_hash)}\t${t.revoked_at ? "revoked" : "active"}`
            );
          }
        }
        return output(ok(lines.join("\n")), g);
      } catch (e) {
        return output(err(e instanceof Error ? e.message : String(e)), g);
      }
    }

    case "revoke": {
      const target = pos[1];
      if (target === undefined) fail("auth revoke requires <hash-prefix|label>", g.json);
      try {
        const lower = target.toLowerCase();
        const active = listTokens().filter((t) => t.revoked_at === null);
        const byHash =
          lower.length >= MIN_HASH_PREFIX
            ? active.filter((t) => t.token_hash.startsWith(lower))
            : [];
        const matches = byHash.length > 0 ? byHash : active.filter((t) => t.label === target);
        if (matches.length === 0) {
          return output(
            err(
              `no active token matches "${target}" (hash prefixes need >= ${MIN_HASH_PREFIX} chars)`
            ),
            g
          );
        }
        if (matches.length > 1) {
          return output(err(`ambiguous "${target}": ${matches.length} active tokens match`), g);
        }
        const match = matches[0]!;
        revokeByHash(match.token_hash);
        return output(
          ok(
            `auth: revoked ${hashPrefix(match.token_hash)} (${match.external_id}${match.label ? `, ${match.label}` : ""})`
          ),
          g
        );
      } catch (e) {
        return output(err(e instanceof Error ? e.message : String(e)), g);
      }
    }

    case "backfill-interactions": {
      const externalId = optStr(opts, "--user");
      if (!externalId) fail("auth backfill-interactions requires --user <external_id>", g.json);
      const sessionId = optStr(opts, "--session");
      const limit = optInt(opts, "--limit") ?? BACKFILL_BATCH_SIZE;
      const dryRun = opts["--dry-run"] === true;
      try {
        const { getUserByExternalId } = await import("../../db/repositories/users.js");
        const { db } = await import("../../db/index.js");
        const user = getUserByExternalId(externalId);
        if (!user) return output(err(`unknown user "${externalId}"`), g);
        const stmt = db.prepare(
          `UPDATE interactions SET user_id = ? WHERE user_id IS NULL ${sessionId ? "AND session_id = ?" : ""}`
        );
        const params = sessionId ? [user.id, sessionId] : [user.id];
        if (dryRun) {
          const countStmt = db.prepare(
            `SELECT COUNT(*) as n FROM interactions WHERE user_id IS NULL ${sessionId ? "AND session_id = ?" : ""}`
          );
          const count = countStmt.get(...params.slice(1)) as { n: number };
          return output(ok(`dry-run: would backfill ${count.n} interaction(s)`), g);
        }
        const result = stmt.run(...params);
        return output(ok(`backfilled ${result.changes} interaction(s) for user ${externalId}`), g);
      } catch (e) {
        return output(err(e instanceof Error ? e.message : String(e)), g);
      }
    }
    default:
      fail(`unknown auth subcommand "${sub}" (see help)`, g.json);
  }
}
