import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type ModelsSimpleStreamOptions,
	normalizeContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	hoistToolResultImages,
	shouldHoistToolResultImages,
	supportsNestedToolResultImages,
	withToolResultImageHoist,
} from "../src/core/bedrock-compat.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

// Upstream issue earendil-works/pi#8643: Bedrock Converse rejects images nested inside
// toolResult.content for every image-capable family except Claude and Nova, wedging the
// session on the next request. The rewrite mirrors the pi-bedrock-compat extension.

const image = { image: { format: "png", source: { bytes: new Uint8Array([1, 2, 3]) } } };

function conversePayload(content: unknown[], modelId = "global.openai.gpt-5.6-sol") {
	return { modelId, messages: [{ role: "user", content }] };
}

function bedrockModel(id: string, name = "", overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name,
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		...overrides,
	};
}

describe("supportsNestedToolResultImages", () => {
	it("recognizes Anthropic Claude and Amazon Nova IDs", () => {
		expect(supportsNestedToolResultImages({ id: "us.anthropic.claude-sonnet-4-6-v1:0" })).toBe(true);
		expect(supportsNestedToolResultImages({ id: "anthropic.claude-opus-4-v1:0" })).toBe(true);
		expect(supportsNestedToolResultImages({ id: "amazon.nova-pro-v1:0" })).toBe(true);
	});

	it("recognizes supported families from application inference profile names", () => {
		expect(
			supportsNestedToolResultImages({
				id: "arn:aws:bedrock:us-east-1:123:application-inference-profile/x",
				name: "Claude Sonnet",
			}),
		).toBe(true);
		expect(
			supportsNestedToolResultImages({
				id: "arn:aws:bedrock:us-east-1:123:application-inference-profile/y",
				name: "Amazon Nova Pro",
			}),
		).toBe(true);
	});

	it("does not exempt other Bedrock families", () => {
		for (const id of [
			"global.openai.gpt-5.6-terra",
			"global.openai.gpt-5.6-luna",
			"global.openai.gpt-5.6-sol",
			"global.openai.gpt-6-astra",
			"moonshotai.kimi-k2.5",
		]) {
			expect(supportsNestedToolResultImages({ id }), id).toBe(false);
		}
	});
});

describe("shouldHoistToolResultImages", () => {
	it("selects Bedrock Converse models of unsupported families", () => {
		expect(shouldHoistToolResultImages(bedrockModel("global.openai.gpt-5.6-sol"))).toBe(true);
		expect(shouldHoistToolResultImages(bedrockModel("moonshotai.kimi-k2.5"))).toBe(true);
	});

	it("excludes Claude, Nova, other providers, and other APIs", () => {
		expect(shouldHoistToolResultImages(bedrockModel("us.anthropic.claude-sonnet-4-6-v1:0"))).toBe(false);
		expect(shouldHoistToolResultImages(bedrockModel("amazon.nova-pro-v1:0"))).toBe(false);
		expect(shouldHoistToolResultImages(bedrockModel("openai.gpt-5.6-sol", undefined, { provider: "openai" }))).toBe(
			false,
		);
		expect(
			shouldHoistToolResultImages(bedrockModel("openai.gpt-5.6-sol", undefined, { api: "openai-responses" })),
		).toBe(false);
		expect(shouldHoistToolResultImages(undefined)).toBe(false);
	});
});

describe("hoistToolResultImages", () => {
	it("moves a nested image beside its tool result", () => {
		const input = conversePayload([
			{
				toolResult: {
					toolUseId: "read-1",
					status: "success",
					content: [{ text: "image.png" }, image],
				},
			},
		]);

		const output = hoistToolResultImages(input) as ReturnType<typeof conversePayload>;

		expect(output.messages[0]).toEqual({
			role: "user",
			content: [
				{
					toolResult: {
						toolUseId: "read-1",
						status: "success",
						content: [{ text: "image.png" }],
					},
				},
				image,
			],
		});
		expect(output).not.toBe(input);
		// The input payload is not mutated: stored history keeps its shape.
		expect(input.messages[0]).toEqual({
			role: "user",
			content: [
				{
					toolResult: {
						toolUseId: "read-1",
						status: "success",
						content: [{ text: "image.png" }, image],
					},
				},
			],
		});
	});

	it("keeps image-only tool results non-empty", () => {
		const input = conversePayload([{ toolResult: { toolUseId: "shot-1", status: "success", content: [image] } }]);

		const output = hoistToolResultImages(input) as ReturnType<typeof conversePayload>;

		expect(output.messages[0]).toEqual({
			role: "user",
			content: [{ toolResult: { toolUseId: "shot-1", status: "success", content: [{ text: "<empty>" }] } }, image],
		});
	});

	it("keeps consecutive tool results together and preserves image order", () => {
		const secondImage = { image: { format: "jpeg", source: { bytes: new Uint8Array([4, 5, 6]) } } };
		const input = conversePayload([
			{ toolResult: { toolUseId: "one", status: "success", content: [{ text: "one" }, image] } },
			{ toolResult: { toolUseId: "two", status: "success", content: [secondImage, { text: "two" }] } },
		]);

		const output = hoistToolResultImages(input) as ReturnType<typeof conversePayload>;

		expect(output.messages[0]).toEqual({
			role: "user",
			content: [
				{ toolResult: { toolUseId: "one", status: "success", content: [{ text: "one" }] } },
				{ toolResult: { toolUseId: "two", status: "success", content: [{ text: "two" }] } },
				image,
				secondImage,
			],
		});
	});

	it("returns unrelated and malformed payloads by identity", () => {
		const inputs: unknown[] = [
			null,
			{},
			{ messages: "invalid" },
			conversePayload([{ text: "hello" }]),
			conversePayload([{ toolResult: { toolUseId: "read", status: "success", content: "invalid" } }]),
		];

		for (const input of inputs) {
			expect(hoistToolResultImages(input)).toBe(input);
		}
	});
});

describe("withToolResultImageHoist", () => {
	it("returns the options unchanged for models that need no hoist", () => {
		for (const model of [
			bedrockModel("us.anthropic.claude-sonnet-4-6-v1:0"),
			bedrockModel("amazon.nova-pro-v1:0"),
			bedrockModel("openai.gpt-5.6-sol", undefined, { provider: "openai" }),
			undefined,
		]) {
			const options: ModelsSimpleStreamOptions = { maxRetries: 0 };
			expect(withToolResultImageHoist(options, model)).toBe(options);
		}
	});

	it("hoists affected payloads when the options carry no onPayload", async () => {
		const model = bedrockModel("global.openai.gpt-5.6-sol");
		const composed = withToolResultImageHoist({}, model);
		expect(composed.onPayload).toBeDefined();

		const output = (await composed.onPayload?.(conversePayload([{ toolResult: { content: [image] } }]), model)) as
			| ReturnType<typeof conversePayload>
			| undefined;

		expect(output?.messages[0]).toEqual({
			role: "user",
			content: [{ toolResult: { content: [{ text: "<empty>" }] } }, image],
		});
	});

	it("runs the hoist after the onPayload already wired into the options", async () => {
		const model = bedrockModel("global.openai.gpt-5.6-sol");
		const observedPayloads: unknown[] = [];
		const options: ModelsSimpleStreamOptions = {
			onPayload: async (payload) => {
				observedPayloads.push(payload);
				return { ...(payload as object), modelId: "redirected" };
			},
		};

		const composed = withToolResultImageHoist(options, model);
		const input = conversePayload([{ toolResult: { toolUseId: "read", status: "success", content: [image] } }]);
		const output = (await composed.onPayload?.(input, model)) as ReturnType<typeof conversePayload>;

		// The prior onPayload (the SDK's before_provider_request extension dispatch) observes
		// the payload exactly as the adapter built it, and its return value is what gets hoisted.
		expect(observedPayloads).toEqual([input]);
		expect(output.modelId).toBe("redirected");
		expect(output.messages[0]).toEqual({
			role: "user",
			content: [{ toolResult: { toolUseId: "read", status: "success", content: [{ text: "<empty>" }] } }, image],
		});
	});

	it("leaves the prior onPayload in place for models that need no hoist", () => {
		const onPayload: ModelsSimpleStreamOptions["onPayload"] = async (payload) => payload;
		const options: ModelsSimpleStreamOptions = { onPayload };

		expect(withToolResultImageHoist(options, bedrockModel("us.anthropic.claude-sonnet-4-6-v1:0"))).toBe(options);
	});
});

describe("createAgentSession Bedrock Converse payload", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-bedrock-compat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createDoneStream() {
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "bedrock-converse-stream",
			provider: "capture-provider",
			model: "capture-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.end(message);
		return stream;
	}

	async function captureOnPayload(model: Model<Api>): Promise<ModelsSimpleStreamOptions["onPayload"]> {
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const authStorage = AuthStorage.inMemory({
			[model.provider]: { type: "api_key", key: "test-api-key" },
		});
		const modelRegistry = await createInMemoryModelRegistry(authStorage);
		let captured: ModelsSimpleStreamOptions | undefined;

		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: (_model, _context, providerOptions) => {
				captured = providerOptions;
				return createDoneStream();
			},
		});

		const modelRuntime = getModelRuntime(modelRegistry);
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager,
			sessionManager,
		});

		try {
			const stream = await session.agent.streamFunction(model, normalizeContext({ messages: [] }), {
				sessionId: session.sessionId,
			});
			await stream.result();
			return captured?.onPayload;
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	}

	it("hoists nested tool-result images for models without nested-image support", async () => {
		const onPayload = await captureOnPayload(bedrockModel("global.openai.gpt-5.6-sol", "GPT-5.6 Sol"));
		expect(onPayload).toBeDefined();

		const input = conversePayload([{ toolResult: { toolUseId: "read", status: "success", content: [image] } }]);
		const output = (await onPayload?.(input, bedrockModel("global.openai.gpt-5.6-sol"))) as
			| ReturnType<typeof conversePayload>
			| undefined;

		expect(output?.messages[0]).toEqual({
			role: "user",
			content: [{ toolResult: { toolUseId: "read", status: "success", content: [{ text: "<empty>" }] } }, image],
		});
	});

	it("wires no payload rewrite for Claude", async () => {
		const model = bedrockModel("us.anthropic.claude-sonnet-4-6-v1:0", "Claude Sonnet 4.6");
		const onPayload = await captureOnPayload(model);

		// No hoist is wired for Claude: the adapter's nested shape is sent unchanged.
		expect(onPayload).toBeUndefined();
	});
});
