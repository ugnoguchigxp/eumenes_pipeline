/** Short pipeline data contract. The p0-3 validation surface exposes parse and safeParse. */
import {
	pipelineStepSchema,
	pipelineDefinitionSchema,
} from "../internal/schemas.ts";
import type { Schema } from "./schema.ts";
export { MAX_STEPS, REQUEST_REF } from "./limits.ts";

export type JsonValue =
	string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type PipelineStep = {
	id: string;
	bundle: string;
	entry?: string;
	task: string;
	from: string[];
	arguments?: Record<string, JsonValue>;
	result: string;
};
export type PipelineDefinition = {
	request: string;
	steps: PipelineStep[];
	output: { from: string[]; deliver: string };
};
export const pipelineStep: Schema<PipelineStep> = pipelineStepSchema;
export const pipelineDefinition: Schema<PipelineDefinition> =
	pipelineDefinitionSchema;
