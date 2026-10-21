import { LINK_RELATIONS } from "../../memory/types.js";
import {
  effectiveImportScope,
  linkAllowed,
  type ImportScopeIdentity,
} from "./common.js";
import type { ImportCounts, ImportLink, ValidatedLink, ValidatedMemory } from "./types.js";

export function validateLinks(
  exportLinks: unknown,
  validMemories: ValidatedMemory[],
  forcedUserId: string | null,
  state: ImportCounts,
  log: string[]
): ValidatedLink[] {
  const validLinks: ValidatedLink[] = [];
  if (exportLinks != null) {
    // Phase-1 remap precheck (no writes): a link is resolvable in phase 2
    // iff both old ids belong to memories validated in THIS batch
    // (mirrors the original importedIds-only rule, but works for dry-run too —
    // the old code always reported links invalid on dry-run because the map
    // was still empty at validate time).
    const batchMemScopes = new Map<number, ImportScopeIdentity>();
    for (const { it } of validMemories) {
      if (typeof it.id === "number" && Number.isInteger(it.id)) {
        batchMemScopes.set(it.id, effectiveImportScope(it, forcedUserId));
      }
    }
    for (const link of exportLinks as ImportLink[]) {
      if (
        typeof link.sourceId !== "number" ||
        typeof link.targetId !== "number" ||
        typeof link.relation !== "string" ||
        !LINK_RELATIONS.includes(link.relation as typeof LINK_RELATIONS[number]) ||
        (link.confidence != null && (typeof link.confidence !== "number" || link.confidence < 0 || link.confidence > 1))
      ) {
        state.linksInvalid++;
        continue;
      }
      const sourceScope = batchMemScopes.get(link.sourceId);
      const targetScope = batchMemScopes.get(link.targetId);
      if (!sourceScope || !targetScope) {
        state.linksInvalid++;
        log.push(`invalid link ${link.sourceId}->${link.targetId}: unresolvable memory id`);
        continue;
      }
      // SEC-04: same scope rule as link_memory (skip + report, never throw).
      if (!linkAllowed(sourceScope, targetScope)) {
        state.linksInvalid++;
        log.push(
          `invalid link ${link.sourceId}->${link.targetId}: scope mismatch (${sourceScope.scope} -> ${targetScope.scope})`
        );
        continue;
      }
      state.linksImported++;
      validLinks.push({ sourceId: link.sourceId, targetId: link.targetId, relation: link.relation, confidence: link.confidence });
    }
  }
  return validLinks;
}
