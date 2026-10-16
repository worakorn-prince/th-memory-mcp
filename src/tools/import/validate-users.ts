import { nowISO } from "../../db/index.js";
import { isIsoDateString } from "../../lib/iso.js";
import type { ImportCounts, ImportUser, ValidatedUser } from "./types.js";

export function validateUsers(exportUsers: unknown, state: ImportCounts): ValidatedUser[] {
  const validUsers: ValidatedUser[] = [];
  if (exportUsers != null) {
    for (const u of exportUsers as ImportUser[]) {
      const external =
        typeof u.externalId === "string"
          ? u.externalId
          : typeof u.external_id === "string"
            ? u.external_id
            : null;
      if (
        !u ||
        !external ||
        external.length === 0 ||
        external.length > 200 ||
        /[\x00-\x1f]/.test(external)
      ) {
        state.usersInvalid++;
        continue;
      }
      const created =
        (typeof u.createdAt === "string" && isIsoDateString(u.createdAt as string)
          ? (u.createdAt as string)
          : typeof u.created_at === "string" && isIsoDateString(u.created_at as string)
            ? (u.created_at as string)
            : null) ?? nowISO();
      const name = typeof u.name === "string" ? (u.name as string).slice(0, 500) : null;
      state.usersImported++;
      validUsers.push({ external, name, created });
    }
  }
  return validUsers;
}
