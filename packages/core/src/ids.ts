import type { Id } from "@earendil-works/pi-durable";

// SAFETY: pi-durable does not export `idFromNumber`, and its ids are plain numbers at runtime.
export const idFromNumber = <I extends Id<string>>(value: number): I => value as I;
