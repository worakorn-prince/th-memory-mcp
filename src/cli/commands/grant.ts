import { err, ok } from "../../db/index.js";
import { fail, optStr, output, type CliOpts, type Globals } from "./shared.js";
import { listUsers, getUserByExternalId } from "../../db/repositories/users.js";
import {
  SCOPE_KINDS,
  GRANT_PERMISSIONS,
  GLOBAL_SCOPE_REF,
  isScopeKind,
  isGrantPermission,
  addGrant,
  removeGrant,
  listGrants,
  type ScopeKind,
  type GrantPermission,
  type ScopeGrantRow,
} from "../../db/repositories/scope_grants.js";

const MAX_REF = 200;

function validateRef(ref: string, kind: ScopeKind): void {
  if (!ref || ref.length === 0 || ref.length > MAX_REF || /[\x00-\x1f]/.test(ref)) {
    fail(`invalid scope ref (1-${MAX_REF} chars, no control characters)`, true);
  }
  if (kind === "GLOBAL" && ref !== GLOBAL_SCOPE_REF) {
    fail(`GLOBAL grants must use ref="*"`, true);
  }
  if (kind === "USER") {
    const target = getUserByExternalId(ref);
    if (target === undefined) {
      fail(`unknown user "${ref}" (run: th-memory auth add-user ${ref})`, true);
    }
  }
}

function formatGrantsTable(rows: ScopeGrantRow[], g: Globals): string {
  if (rows.length === 0) return "(no grants)";
  const lines = ["id\tgrantee\tkind\tref\tpermission\tgranted_by\tcreated_at"];
  for (const r of rows) {
    const grantee = listUsers().find((u) => u.id === r.grantee_user_id)?.external_id ?? String(r.grantee_user_id);
    const grantedBy = r.granted_by ? listUsers().find((u) => u.id === r.granted_by)?.external_id ?? String(r.granted_by) : "-";
    lines.push(`${r.id}\t${grantee}\t${r.scope_kind}\t${r.scope_ref}\t${r.permission}\t${grantedBy}\t${r.created_at}`);
  }
  return lines.join("\n");
}

export async function runGrant(opts: CliOpts, pos: string[], g: Globals): Promise<number> {
  const sub = pos[0];
  if (sub === undefined) fail("grant requires <add|remove|list> (see help)", g.json);

  switch (sub) {
    case "add": {
      const externalId = optStr(opts, "--user");
      if (externalId === undefined) fail("grant add requires --user <external_id>", g.json);

      const kindRaw = optStr(opts, "--kind");
      if (kindRaw === undefined) fail("grant add requires --kind <USER|PROJECT|SESSION|GLOBAL>", g.json);
      if (!isScopeKind(kindRaw)) fail(`--kind must be ${SCOPE_KINDS.join("|")} (got "${kindRaw}")`, g.json);
      const kind: ScopeKind = kindRaw;

      const ref = optStr(opts, "--ref");
      if (ref === undefined) fail("grant add requires --ref <target_id>", g.json);

      const permRaw = optStr(opts, "--permission");
      if (permRaw === undefined) fail("grant add requires --permission <read|write>", g.json);
      if (!isGrantPermission(permRaw)) fail(`--permission must be ${GRANT_PERMISSIONS.join("|")} (got "${permRaw}")`, g.json);
      const permission: GrantPermission = permRaw;

      validateRef(ref, kind);

      const grantee = getUserByExternalId(externalId);
      if (grantee === undefined) {
        return output(err(`unknown user "${externalId}" (run: th-memory auth add-user ${externalId})`), g);
      }

      try {
        addGrant(grantee.id, kind, ref, permission);
        if (g.json) {
          return output(ok(JSON.stringify({ ok: true, user: externalId, kind, ref, permission })), g);
        }
        return output(ok(`grant: added ${permission} on ${kind}:${ref} for ${externalId}`), g);
      } catch (e) {
        return output(err(e instanceof Error ? e.message : String(e)), g);
      }
    }

    case "remove": {
      const externalId = optStr(opts, "--user");
      if (externalId === undefined) fail("grant remove requires --user <external_id>", g.json);

      const kindRaw = optStr(opts, "--kind");
      if (kindRaw === undefined) fail("grant remove requires --kind <USER|PROJECT|SESSION|GLOBAL>", g.json);
      if (!isScopeKind(kindRaw)) fail(`--kind must be ${SCOPE_KINDS.join("|")} (got "${kindRaw}")`, g.json);
      const kind: ScopeKind = kindRaw;

      const ref = optStr(opts, "--ref");
      if (ref === undefined) fail("grant remove requires --ref <target_id>", g.json);

      const permRaw = optStr(opts, "--permission");
      if (permRaw === undefined) fail("grant remove requires --permission <read|write>", g.json);
      if (!isGrantPermission(permRaw)) fail(`--permission must be ${GRANT_PERMISSIONS.join("|")} (got "${permRaw}")`, g.json);
      const permission: GrantPermission = permRaw;

      validateRef(ref, kind);

      const grantee = getUserByExternalId(externalId);
      if (grantee === undefined) {
        return output(err(`unknown user "${externalId}" (run: th-memory auth add-user ${externalId})`), g);
      }

      try {
        const removed = removeGrant(grantee.id, kind, ref, permission);
        if (g.json) {
          return output(ok(JSON.stringify({ ok: true, removed })), g);
        }
        if (removed) {
          return output(ok(`grant: removed ${permission} on ${kind}:${ref} for ${externalId}`), g);
        }
        return output(err(`grant not found: ${permission} on ${kind}:${ref} for ${externalId}`), g);
      } catch (e) {
        return output(err(e instanceof Error ? e.message : String(e)), g);
      }
    }

    case "list":
    case "ls": {
      const externalId = optStr(opts, "--user");
      let granteeUid: number | undefined;
      if (externalId !== undefined) {
        const grantee = getUserByExternalId(externalId);
        if (grantee === undefined) {
          return output(err(`unknown user "${externalId}"`), g);
        }
        granteeUid = grantee.id;
      }

      try {
        const rows = listGrants(granteeUid);
        if (g.json) {
          const data = rows.map((r) => {
            const grantee = listUsers().find((u) => u.id === r.grantee_user_id)?.external_id ?? String(r.grantee_user_id);
            const grantedBy = r.granted_by ? listUsers().find((u) => u.id === r.granted_by)?.external_id ?? String(r.granted_by) : null;
            return { id: r.id, grantee, kind: r.scope_kind, ref: r.scope_ref, permission: r.permission, granted_by: grantedBy, created_at: r.created_at };
          });
          return output(ok(JSON.stringify(data)), g);
        }
        return output(ok(formatGrantsTable(rows, g)), g);
      } catch (e) {
        return output(err(e instanceof Error ? e.message : String(e)), g);
      }
    }

    default:
      fail(`unknown grant subcommand "${sub}" (see help)`, g.json);
  }
}