/** Match evaluator-declared role graphs; never infer required work from request words. */
import { z } from "zod";
import { ENTRY_PATTERN } from "../../src/contracts/component.ts";

const roleId = z.string().min(1).max(60);
export const wiringAlternative = z
	.strictObject({
		roles: z
			.array(
				z.strictObject({
					id: roleId,
					entries: z.array(z.string().regex(ENTRY_PATTERN)).min(1).max(8),
				}),
			)
			.min(1)
			.max(8),
		edges: z.array(z.strictObject({ from: roleId, to: roleId })).max(64),
		deliver: z.array(roleId).max(8),
	})
	.superRefine((value, ctx) => {
		const names = new Set(value.roles.map((r) => r.id));
		if (
			names.size !== value.roles.length ||
			value.edges.some(
				(e) => !names.has(e.from) || !names.has(e.to) || e.from === e.to,
			) ||
			value.deliver.some((id) => !names.has(id))
		)
			ctx.addIssue({
				code: "custom",
				message:
					"wiring roles must be unique and all references must name declared distinct roles",
			});
	});
export type WiringAlternative = z.infer<typeof wiringAlternative>;

export type WiringStep = {
	id: string;
	entry: string | null;
	from: readonly string[];
};

export function matchesWiring(
	steps: readonly WiringStep[],
	delivered: readonly string[],
	alternatives: readonly WiringAlternative[],
): boolean {
	return alternatives.some((rule) => {
		const assigned = new Map<string, WiringStep>();
		const used = new Set<string>();
		const valid = () =>
			rule.edges.every((edge) => {
				const from = assigned.get(edge.from);
				const to = assigned.get(edge.to);
				return !from || !to || to.from.includes(from.id);
			});
		const visit = (index: number): boolean => {
			const role = rule.roles[index];
			if (!role) return valid();
			for (const step of steps) {
				if (
					used.has(step.id) ||
					step.entry === null ||
					!role.entries.includes(step.entry)
				)
					continue;
				if (rule.deliver.includes(role.id) && !delivered.includes(step.id))
					continue;
				assigned.set(role.id, step);
				used.add(step.id);
				if (valid() && visit(index + 1)) return true;
				used.delete(step.id);
				assigned.delete(role.id);
			}
			return false;
		};
		return visit(0);
	});
}
