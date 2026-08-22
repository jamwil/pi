import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);

const state = vi.hoisted(() => {
	const originalMarker = process.env.PI_STANDALONE_BUNDLE;
	process.env.PI_STANDALONE_BUNDLE = "1";
	return {
		originalMarker,
		createJiti: vi.fn((_id: unknown, _options: unknown) => ({
			import: vi.fn(async () => () => {}),
		})),
	};
});

vi.mock("jiti/static", () => ({ createJiti: state.createJiti }));

import { loadExtensions } from "../src/core/extensions/loader.ts";

interface JitiOptionsProbe {
	alias?: unknown;
	tryNative?: boolean;
	virtualModules?: Record<string, unknown>;
}

afterAll(() => {
	if (state.originalMarker === undefined) {
		delete process.env.PI_STANDALONE_BUNDLE;
	} else {
		process.env.PI_STANDALONE_BUNDLE = state.originalMarker;
	}
});

describe("standalone extension loading", () => {
	it("uses embedded compatibility modules instead of filesystem aliases", async () => {
		const result = await loadExtensions(["/extension.ts"], "/");

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(state.createJiti).toHaveBeenCalledOnce();

		const options = state.createJiti.mock.calls[0][1] as JitiOptionsProbe;
		expect(options.tryNative).toBe(false);
		expect(options.alias).toBeUndefined();
		expect(options.virtualModules?.typebox).toBeDefined();
		expect(options.virtualModules?.["@earendil-works/pi-ai"]).toBeDefined();
		expect(options.virtualModules?.["@earendil-works/pi-tui"]).toBeDefined();
		expect(options.virtualModules?.["@earendil-works/pi-coding-agent"]).toBeDefined();
	});
});

// The built artifacts only exist after `npm run build`. These tests gate the
// bundles the release smoke test extracts: a bundle that cannot even parse
// (for example, a banner/import alias collision in build-standalone.mjs) must
// fail the suite, not just the release smoke test.
describe("standalone dist bundles", () => {
	const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
	const standaloneDir = join(packageDir, "dist", "standalone");
	const outputs = ["cli.mjs", "codemode-worker.js", "image-resize-worker.js"];
	const built = existsSync(join(standaloneDir, "cli.mjs"));

	it("are parseable as ESM under bare Node", async (ctx) => {
		if (!built) ctx.skip();
		for (const name of outputs) {
			await execFileAsync(process.execPath, ["--check", join(standaloneDir, name)]);
		}
	});

	it("cli.mjs executes and reports the package version", async (ctx) => {
		if (!built) ctx.skip();
		const home = mkdtempSync(join(tmpdir(), "pi-standalone-test-"));
		try {
			const { stdout } = await execFileAsync(process.execPath, [join(standaloneDir, "cli.mjs"), "--version"], {
				env: { ...process.env, HOME: home },
			});
			const expected = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version;
			expect(stdout.trim()).toBe(expected);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
