import type { Api, Model, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";

/**
 * Compatibility fixes for models accessed through Amazon Bedrock Converse.
 *
 * Bedrock rejects images nested inside `toolResult.content` for every image-capable model
 * family except Anthropic Claude and Amazon Nova:
 *
 * `ValidationException: This model doesn't support the image field for user messages.`
 *
 * Any tool that returns an image wedges the session: every later request of it keeps failing
 * (observed with `us.openai.gpt-5.6-sol` and `global.openai.gpt-6-luna`; see upstream issue
 * earendil-works/pi#8643). AWS documents `ToolResultContentBlock.image` support only for Claude
 * and Nova, so for other families the images must ride beside their tool results as sibling
 * user content blocks of the same message, which Bedrock accepts.
 *
 * The rewrite applies to the outgoing provider payload only; stored session history is
 * unchanged. It is applied in the coding agent (see `withToolResultImageHoist`) rather than in
 * pi-ai, so the fork keeps depending on the published upstream `@earendil-works/pi-ai` package.
 * The payload shape and family gate mirror the pi-bedrock-compat extension
 * (https://pi.dev/packages/pi-bedrock-compat), which implements the same rewrite as a
 * `before_provider_request` extension hook.
 *
 * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolResultContentBlock.html
 */

const EMPTY_TEXT_PLACEHOLDER = "<empty>";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isImageBlock(value: unknown): value is UnknownRecord {
	return isRecord(value) && isRecord(value.image);
}

function isSupportedNestedImageFamily(value: string): boolean {
	const normalized = value.toLowerCase().replace(/[\s_/:]+/gu, ".");

	return (
		normalized.includes("anthropic.claude") ||
		/(?:^|\.)claude(?:\.|$)/u.test(normalized) ||
		normalized.includes("amazon.nova") ||
		/(?:^|\.)nova(?:\.|$)/u.test(normalized)
	);
}

/**
 * Whether Bedrock documents the model family as accepting images inside `toolResult.content`.
 * Checks the model ID and name, so base models, system-defined inference profiles
 * (`us.`/`global.` prefixes), and application inference profiles (whose ARNs identify the
 * model only by name) are all covered.
 */
export function supportsNestedToolResultImages(model: { id: string; name?: string }): boolean {
	return [model.id, model.name].some((value) => typeof value === "string" && isSupportedNestedImageFamily(value));
}

/**
 * Whether outgoing requests for this model must hoist tool-result images beside the tool
 * results. Only Bedrock Converse models of families without documented nested-image support
 * need the rewrite.
 */
export function shouldHoistToolResultImages(model: Model<Api> | undefined): boolean {
	return isBedrockConverseModelWithoutNestedImages(model);
}

function isBedrockConverseModelWithoutNestedImages(
	model: Model<Api> | undefined,
): model is Model<"bedrock-converse-stream"> {
	return (
		model !== undefined &&
		model.provider === "amazon-bedrock" &&
		model.api === "bedrock-converse-stream" &&
		!supportsNestedToolResultImages(model)
	);
}

function rewriteMessage(message: unknown): { message: unknown; changed: boolean } {
	if (!isRecord(message) || !Array.isArray(message.content)) {
		return { message, changed: false };
	}

	const hoistedImages: UnknownRecord[] = [];
	let changed = false;
	const content = message.content.map((block) => {
		if (!isRecord(block) || !isRecord(block.toolResult)) {
			return block;
		}

		const toolResult = block.toolResult;
		if (!Array.isArray(toolResult.content)) {
			return block;
		}

		const images = toolResult.content.filter(isImageBlock);
		if (images.length === 0) {
			return block;
		}

		const remaining = toolResult.content.filter((item) => !isImageBlock(item));
		hoistedImages.push(...images);
		changed = true;

		return {
			...block,
			toolResult: {
				...toolResult,
				content: remaining.length > 0 ? remaining : [{ text: EMPTY_TEXT_PLACEHOLDER }],
			},
		};
	});

	if (!changed) {
		return { message, changed: false };
	}

	return {
		message: { ...message, content: [...content, ...hoistedImages] },
		changed: true,
	};
}

/**
 * Hoist images out of Bedrock Converse tool results without mutating the input payload:
 * each image becomes a sibling user content block after every tool result of its message.
 * Bedrock requires non-empty tool results, so a result left without content sends a text
 * placeholder instead. Malformed or unrelated payloads are returned unchanged.
 */
export function hoistToolResultImages(payload: unknown): unknown {
	if (!isRecord(payload) || !Array.isArray(payload.messages)) {
		return payload;
	}

	let changed = false;
	const messages = payload.messages.map((message) => {
		const rewritten = rewriteMessage(message);
		changed ||= rewritten.changed;
		return rewritten.message;
	});

	return changed ? { ...payload, messages } : payload;
}

/**
 * Apply the tool-result image hoist to a session's provider request options (upstream issue
 * earendil-works/pi#8643). The upstream Bedrock Converse adapter invokes `onPayload` on its
 * converted Converse payload, so composing the rewrite there covers session, compaction, and
 * cache-warming requests alike. Any `onPayload` already wired into the options (the SDK's
 * `before_provider_request` extension dispatch) runs first, so extensions observe the payload
 * the adapter built. Returns the options unchanged for models that need no rewrite.
 */
export function withToolResultImageHoist(
	options: ModelsSimpleStreamOptions,
	model: Model<Api> | undefined,
): ModelsSimpleStreamOptions {
	if (!isBedrockConverseModelWithoutNestedImages(model)) {
		return options;
	}

	const dispatchToExtensions = options.onPayload;
	return {
		...options,
		onPayload: async (payload: unknown) => {
			const observed = dispatchToExtensions ? await dispatchToExtensions(payload, model) : payload;
			return hoistToolResultImages(observed);
		},
	};
}
