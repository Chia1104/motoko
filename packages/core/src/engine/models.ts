import type { Models } from "@earendil-works/pi-ai/models";
import type { HarnessOptions } from "@earendil-works/pi-durable";

import { ModelsUnavailableError } from "../errors.ts";
import type { StorageScope } from "../host.ts";

/** What `modelsFor` resolves for a scope: what `models` would be for a runtime of that one instance. */
export type ModelsResolver = (scope: StorageScope) => HarnessOptions["models"] | Promise<HarnessOptions["models"]>;

type Resolved =
  | { readonly ok: true; readonly models: HarnessOptions["models"] }
  | { readonly ok: false; readonly error: unknown };

/**
 * One open instance's model access when the app resolves it per scope. pi-durable reads
 * `HarnessOptions.models` synchronously at each use, so the async lookup happens beforehand, in
 * `refresh()`, and pi-durable reads the newest result through `get`. The newest resolution wins,
 * failed or not: after a failed one every model request fails with `ModelsUnavailableError`, which
 * ends the run it serves, until a later resolution succeeds. Nothing of it outlives the open.
 */
export class ModelAccess {
  readonly #scope: StorageScope;
  readonly #resolve: ModelsResolver;
  readonly #failed: (error: unknown) => void;
  #current: Resolved | undefined;
  #started = 0;
  #applied = 0;

  constructor(scope: StorageScope, resolve: ModelsResolver, failed: (error: unknown) => void) {
    this.#scope = scope;
    this.#resolve = resolve;
    this.#failed = failed;
  }

  /** Resolves the scope's models again. Never rejects: a failure is reported and held. */
  async refresh(): Promise<void> {
    const seq = ++this.#started;
    let next: Resolved;
    try {
      const models = await this.#resolve(this.#scope);
      if ((typeof models !== "object" && typeof models !== "function") || models === null) {
        throw new TypeError("modelsFor returned neither a Models nor a function returning one");
      }
      next = { ok: true, models };
    } catch (error) {
      this.#failed(error);
      next = { ok: false, error };
    }
    // Resolutions may overlap; the one started last decides.
    if (seq > this.#applied) {
      this.#applied = seq;
      this.#current = next;
    }
  }

  /** `HarnessOptions.models` for pi-durable: called at each use, it throws while the newest resolution failed. */
  readonly get = (): Models => {
    const current = this.#current;
    if (current === undefined || !current.ok) throw new ModelsUnavailableError(this.#scope, current?.error);
    return typeof current.models === "function" ? current.models() : current.models;
  };
}
