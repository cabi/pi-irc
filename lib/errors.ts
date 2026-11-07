/**
 * Small shared helpers for working with `unknown` values from the outside
 * world (caught errors, parsed JSON) without inline type assertions.
 */

/** Human-readable message of a caught value — Errors keep theirs, the rest stringify. */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
