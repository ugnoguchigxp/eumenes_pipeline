/**
 * The format parsers of the P0 comparison, by format id. All three share the unverified-outcome
 * contract (see `outcome.ts`); validation is the runner's job, not a parser's.
 */
import { parseFreeMd } from "./free-md.ts";
import { parseJsonFormat } from "./json.ts";
import { parseMdYaml } from "./md-yaml.ts";
import type { FormatParser } from "./outcome.ts";

export const FORMAT_PARSERS = {
	json: parseJsonFormat,
	"md-yaml": parseMdYaml,
	"free-md": parseFreeMd,
} as const satisfies Record<string, FormatParser>;

export type FormatId = keyof typeof FORMAT_PARSERS;
export const FORMAT_IDS = Object.keys(FORMAT_PARSERS) as FormatId[];

export type {
	FormatParser,
	ParseFailure,
	ParseResult,
	ParsedOutcome,
} from "./outcome.ts";
export { parseFreeMd } from "./free-md.ts";
export { parseJsonFormat } from "./json.ts";
export { parseMdYaml } from "./md-yaml.ts";
export {
	renderCardsJson,
	renderCardsText,
	summarizeArguments,
} from "./cards.ts";
