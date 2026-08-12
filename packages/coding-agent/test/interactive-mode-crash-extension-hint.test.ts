import { describe, expect, test } from "vitest";
import { formatCrashExtensionHint } from "../src/modes/interactive/interactive-mode.ts";

describe("InteractiveMode crash extension hints", () => {
	test("identifies extensions with frames in a crash stack", () => {
		expect(formatCrashExtensionHint(["npm:pi-observational-memory"])).toBe(
			"A stack frame came from loaded extension `npm:pi-observational-memory`, which may be involved. Try disabling it with `pi config`, or run `pi -ne` to confirm.",
		);
		expect(formatCrashExtensionHint(undefined)).toBeUndefined();
	});
});
