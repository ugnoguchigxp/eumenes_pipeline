/** Shared data-contract limits, independent of the validation implementation. */
export const MAX_STEPS = 8;
export const REQUEST_REF = "request";
/** Nesting deeper than this is a parse failure for composed JSON (fixed before comparison, plan §10). */
export const MAX_JSON_DEPTH = 64;
