/** Stable validation surface. Internal Zod types must not add host-environment requirements. */
export type ValidationIssue = {
	code: string;
	path: PropertyKey[];
	message: string;
};
export type ValidationError = { issues: ValidationIssue[]; message: string };
export type ValidationResult<T> =
	{ success: true; data: T } | { success: false; error: ValidationError };
export type Schema<T> = {
	parse(input: unknown): T;
	safeParse(input: unknown): ValidationResult<T>;
};
