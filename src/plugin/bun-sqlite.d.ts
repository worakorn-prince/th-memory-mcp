// Ambient types for the optional Bun SQLite driver.
// The plugin resolves it with a dynamic import fallback, and src/plugin is
// excluded from the main build (tsconfig.json), so the bare specifier needs a
// local declaration for `npm run typecheck:plugin` to pass without Bun types.
declare module "bun:sqlite" {
  export class Database {
    constructor(filename?: string, options?: unknown);
    exec(sql: string): unknown;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      run(...params: unknown[]): unknown;
    };
  }
}
