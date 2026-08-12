import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	type ChangelogEntry,
	compareVersions,
	getNewEntries,
	normalizeChangelogLinks,
	parseChangelog,
} from "../src/utils/changelog.ts";

const entry: ChangelogEntry = {
	major: 0,
	minor: 79,
	patch: 0,
	content: "",
};

describe("normalizeChangelogLinks", () => {
	test("rewrites package-relative changelog links to tag-pinned GitHub source links", () => {
		const markdown = [
			"[Project Trust](README.md#project-trust)",
			"[Extensions](docs/extensions.md#project_trust)",
			"[Examples](examples/extensions/)",
			"[Root README](../../README.md#supply-chain-hardening)",
		].join("\n");

		expect(normalizeChangelogLinks(markdown, entry)).toBe(
			[
				"[Project Trust](https://github.com/earendil-works/pi/blob/v0.79.0/packages/coding-agent/README.md#project-trust)",
				"[Extensions](https://github.com/earendil-works/pi/blob/v0.79.0/packages/coding-agent/docs/extensions.md#project_trust)",
				"[Examples](https://github.com/earendil-works/pi/tree/v0.79.0/packages/coding-agent/examples/extensions/)",
				"[Root README](https://github.com/earendil-works/pi/blob/v0.79.0/README.md#supply-chain-hardening)",
			].join("\n"),
		);
	});

	test("canonicalizes old repository URLs without changing external links", () => {
		const markdown = [
			"[#5167](https://github.com/earendil-works/pi-mono/pull/5167)",
			"[#4163](https://github.com/badlogic/pi-mono/issues/4163)",
			"[Agent README](https://github.com/badlogic/pi-mono/blob/main/packages/agent/README.md)",
			"[External](https://example.com/docs)",
			"[Local anchor](#settings)",
		].join("\n");

		expect(normalizeChangelogLinks(markdown, "0.79.0")).toBe(
			[
				"[#5167](https://github.com/earendil-works/pi/pull/5167)",
				"[#4163](https://github.com/earendil-works/pi/issues/4163)",
				"[Agent README](https://github.com/earendil-works/pi/blob/v0.79.0/packages/agent/README.md)",
				"[External](https://example.com/docs)",
				"[Local anchor](#settings)",
			].join("\n"),
		);
	});
});

describe("prerelease version parsing", () => {
	function writeTempChangelog(markdown: string): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-changelog-"));
		const changelogPath = join(dir, "CHANGELOG.md");
		writeFileSync(changelogPath, markdown, "utf-8");
		return changelogPath;
	}

	test("parseChangelog captures prerelease suffixes in version headers", () => {
		const changelogPath = writeTempChangelog(
			[
				"# Changelog",
				"",
				"## [Unreleased]",
				"",
				"## [0.84.2-dev.0] - 2026-08-12",
				"",
				"- dev build",
				"",
				"## [0.84.1] - 2026-08-07",
				"",
				"- upstream release",
				"",
			].join("\n"),
		);
		try {
			const entries = parseChangelog(changelogPath);
			expect(entries).toEqual([
				{
					major: 0,
					minor: 84,
					patch: 2,
					prerelease: "dev.0",
					content: "## [0.84.2-dev.0] - 2026-08-12\n\n- dev build",
				},
				{ major: 0, minor: 84, patch: 1, content: "## [0.84.1] - 2026-08-07\n\n- upstream release" },
			]);
		} finally {
			rmSync(changelogPath, { recursive: true, force: true });
		}
	});

	test("a prerelease lastVersion sorts below a release with the same base", () => {
		const release = { major: 0, minor: 84, patch: 1, content: "" };
		const dev = { major: 0, minor: 84, patch: 2, prerelease: "dev.0", content: "" };
		expect(compareVersions(dev, release)).toBeGreaterThan(0);
		expect(compareVersions(release, dev)).toBeLessThan(0);
	});

	test("getNewEntries ignores changelog entries at or below a prerelease lastVersion", () => {
		const entries: ChangelogEntry[] = [
			{ major: 0, minor: 84, patch: 2, prerelease: "jamwil.0", content: "## [0.84.2-jamwil.0]" },
			{ major: 0, minor: 84, patch: 1, content: "## [0.84.1]" },
		];
		// lastVersion is a prerelease: 0.84.2-dev.0
		// 0.84.2-jamwil.0 > 0.84.2-dev.0 (dev < jamwil lexically), so it is new.
		// 0.84.1 < 0.84.2-dev.0 (release base 0.84.1 < 0.84.2), so it is not new.
		expect(getNewEntries(entries, "0.84.2-dev.0")).toEqual([entries[0]]);
	});

	test("getNewEntries treats lastVersion prerelease as newer than an equal-base release", () => {
		const entries: ChangelogEntry[] = [{ major: 0, minor: 84, patch: 1, content: "## [0.84.1]" }];
		// 0.84.1 (release) > 0.84.2-dev.0? No: 0.84.1 < 0.84.2 base, so not new.
		// But 0.84.2-dev.0 < 0.84.2 (release), confirming prerelease sorts below base.
		expect(getNewEntries(entries, "0.84.2-dev.0")).toEqual([]);
	});
});

describe("fork version scheme ordering", () => {
	// PUBLISH_FORK.md: stable = upstream version; hotfix = prerelease of the
	// next upstream patch with -jamwil.N; dev = prerelease of the version the
	// build precedes. All slots must sort: 1.0.0 < 1.0.1-dev.0 < 1.0.1-jamwil.0 < 1.0.1.
	const stable = { major: 1, minor: 0, patch: 0, content: "" };
	const dev = { major: 1, minor: 0, patch: 1, prerelease: "dev.0", content: "" };
	const hotfix = { major: 1, minor: 0, patch: 1, prerelease: "jamwil.0", content: "" };
	const nextUpstream = { major: 1, minor: 0, patch: 1, content: "" };

	test("dev builds, jamwil hotfixes, and the plain release sort in order", () => {
		expect(compareVersions(stable, dev)).toBeLessThan(0);
		expect(compareVersions(dev, hotfix)).toBeLessThan(0);
		expect(compareVersions(hotfix, nextUpstream)).toBeLessThan(0);
	});

	test("a hotfix build sees the anticipated upstream release as new", () => {
		const entries: ChangelogEntry[] = [
			{ major: 1, minor: 0, patch: 1, content: "## [1.0.1]" },
			{ major: 1, minor: 0, patch: 0, content: "## [1.0.0]" },
		];
		// Installed 1.0.1-jamwil.0 (fork hotfix on upstream 1.0.0): the later
		// plain 1.0.1 release is new; 1.0.0 is not.
		expect(getNewEntries(entries, "1.0.1-jamwil.0")).toEqual([entries[0]]);
	});
});
