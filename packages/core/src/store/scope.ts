// Scopes of a shared-database store: one row each, owning every row keyed by its `scope_id`. Creating a scope is an
// INSERT, never DDL: the lease's acquiring statement creates the row on first use.

import { assertScope } from "../host.ts";
import type { StorageScope } from "../host.ts";

/**
 * A copy of `scope` once the runtime's `assertScope` accepts it. Its rules (well-formed Unicode, no NUL, 1 to 1024
 * characters) are what a database's text column stores losslessly.
 */
export function validateScope(scope: StorageScope): StorageScope {
  assertScope(scope);
  return { kind: scope.kind, name: scope.name };
}

export const describeScope = (scope: StorageScope): string =>
  `${JSON.stringify(scope.kind)}/${JSON.stringify(scope.name)}`;
