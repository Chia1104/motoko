import { assertScope } from "../host.ts";
import type { StorageScope } from "../host.ts";

export function validateScope(scope: StorageScope): StorageScope {
  assertScope(scope);
  return { kind: scope.kind, name: scope.name };
}

export const describeScope = (scope: StorageScope): string =>
  `${JSON.stringify(scope.kind)}/${JSON.stringify(scope.name)}`;
