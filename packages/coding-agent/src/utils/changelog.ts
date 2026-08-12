import path from "node:path";
import { existsSync, readFileSync } from "fs";
import { compare, valid } from "semver";

export interface ChangelogEntry {
	major: number;
	minor: number;
	patch: number;
	prerelease?: string;
	content: string;
}

const GITHUB_REPO = "earendil-works/pi";
const CHANGELOG_LINK_BASE_PATH = "packages/coding-agent";
const LEGACY_REPO_RE = /^https:\/\/github\.com\/(?:badlogic|earendil-works)\/pi-mono(?=\/|$)/;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const INLINE_MARKDOWN_LINK_RE = /(!?\[[^\]\n]+\]\()([^\s)]+)((?:\s+[^)]*)?\))/g;

function entryVersion(entry: ChangelogEntry): string {
	const base = `${entry.major}.${entry.minor}.${entry.patch}`;
	return entry.prerelease ? `${base}-${entry.prerelease}` : base;
}

function normalizeTag(version: string | ChangelogEntry): string {
	const versionString = typeof version === "string" ? version : entryVersion(version);
	return versionString.startsWith("v") ? versionString : `v${versionString}`;
}

function splitLocalTarget(target: string): { fragment: string; pathPart: string; query: string } {
	const hashIndex = target.indexOf("#");
	const beforeHash = hashIndex === -1 ? target : target.slice(0, hashIndex);
	const fragment = hashIndex === -1 ? "" : target.slice(hashIndex);
	const queryIndex = beforeHash.indexOf("?");

	if (queryIndex === -1) {
		return { fragment, pathPart: beforeHash, query: "" };
	}

	return {
		fragment,
		pathPart: beforeHash.slice(0, queryIndex),
		query: beforeHash.slice(queryIndex),
	};
}

function normalizePathPart(value: string): string {
	return value.replaceAll("\\", "/");
}

function resolveRepositoryPath(targetPath: string): string | undefined {
	const normalizedTarget = normalizePathPart(targetPath);
	const joined = normalizedTarget.startsWith("/")
		? path.posix.normalize(normalizedTarget.replace(/^\/+/, ""))
		: path.posix.normalize(path.posix.join(CHANGELOG_LINK_BASE_PATH, normalizedTarget));

	if (joined === "." || joined.startsWith("../") || joined === "..") {
		return undefined;
	}

	return joined;
}

function isDirectoryTarget(originalPath: string, repositoryPath: string): boolean {
	if (originalPath.endsWith("/")) {
		return true;
	}

	const basename = path.posix.basename(repositoryPath);
	return !basename.includes(".");
}

function normalizeChangelogLinkTarget(target: string, tag: string): string {
	let canonicalTarget = target.replace(LEGACY_REPO_RE, `https://github.com/${GITHUB_REPO}`);
	const repoUrl = `https://github.com/${GITHUB_REPO}`;

	for (const route of ["blob", "tree"]) {
		for (const branch of ["main", "master"]) {
			const floatingRefPrefix = `${repoUrl}/${route}/${branch}/`;
			if (canonicalTarget.startsWith(floatingRefPrefix)) {
				canonicalTarget = `${repoUrl}/${route}/${tag}/${canonicalTarget.slice(floatingRefPrefix.length)}`;
			}
		}
	}

	if (canonicalTarget.startsWith("#") || canonicalTarget.startsWith("//") || URL_SCHEME_RE.test(canonicalTarget)) {
		return canonicalTarget;
	}

	const { fragment, pathPart, query } = splitLocalTarget(canonicalTarget);
	if (!pathPart) {
		return canonicalTarget;
	}

	const repositoryPath = resolveRepositoryPath(pathPart);
	if (!repositoryPath) {
		return canonicalTarget;
	}

	const route = isDirectoryTarget(pathPart, repositoryPath) ? "tree" : "blob";
	return `https://github.com/${GITHUB_REPO}/${route}/${tag}/${encodeURI(repositoryPath)}${query}${fragment}`;
}

export function normalizeChangelogLinks(markdown: string, version: string | ChangelogEntry): string {
	const tag = normalizeTag(version);
	return markdown.replace(INLINE_MARKDOWN_LINK_RE, (_match, prefix, target, suffix) => {
		return `${prefix}${normalizeChangelogLinkTarget(target, tag)}${suffix}`;
	});
}

/**
 * Parse changelog entries from CHANGELOG.md
 * Scans for ## lines and collects content until next ## or EOF
 */
export function parseChangelog(changelogPath: string): ChangelogEntry[] {
	if (!existsSync(changelogPath)) {
		return [];
	}

	try {
		const content = readFileSync(changelogPath, "utf-8");
		const lines = content.split("\n");
		const entries: ChangelogEntry[] = [];

		let currentLines: string[] = [];
		let currentVersion: { major: number; minor: number; patch: number } | null = null;

		for (const line of lines) {
			// Check if this is a version header (## [x.y.z] ...)
			if (line.startsWith("## ")) {
				// Save previous entry if exists
				if (currentVersion && currentLines.length > 0) {
					entries.push({
						...currentVersion,
						content: currentLines.join("\n").trim(),
					});
				}

				// Try to parse version from this line
				const versionMatch = line.match(/##\s+\[?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?\]?/);
				if (versionMatch) {
					currentVersion = {
						major: Number.parseInt(versionMatch[1], 10),
						minor: Number.parseInt(versionMatch[2], 10),
						patch: Number.parseInt(versionMatch[3], 10),
						...(versionMatch[4] ? { prerelease: versionMatch[4] } : {}),
					};
					currentLines = [line];
				} else {
					// Reset if we can't parse version
					currentVersion = null;
					currentLines = [];
				}
			} else if (currentVersion) {
				// Collect lines for current version
				currentLines.push(line);
			}
		}

		// Save last entry
		if (currentVersion && currentLines.length > 0) {
			entries.push({
				...currentVersion,
				content: currentLines.join("\n").trim(),
			});
		}

		return entries;
	} catch {
		// Shown in the TUI (startup notes, /changelog), where printing would draw over the screen. An unreadable
		// changelog shows no notes instead.
		return [];
	}
}

/**
 * Compare versions including prerelease tags. Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2.
 * Falls back to numeric major/minor/patch comparison when either side is not a
 * valid semver string (e.g. a malformed header).
 */
export function compareVersions(v1: ChangelogEntry, v2: ChangelogEntry): number {
	const a = valid(entryVersion(v1));
	const b = valid(entryVersion(v2));
	if (a && b) {
		return compare(a, b);
	}
	if (v1.major !== v2.major) return v1.major - v2.major;
	if (v1.minor !== v2.minor) return v1.minor - v2.minor;
	return v1.patch - v2.patch;
}

/**
 * Get entries newer than lastVersion, or undefined when lastVersion has no major.minor.patch to compare against.
 * The fork publishes semver prereleases (X.Y.Z-dev.N, X.Y.Z-jamwil.N), so lastVersion may carry a
 * prerelease suffix; it sorts below its associated release per semver precedence, so a user on a
 * fork prerelease still sees the release's notes once the rebase carries them. Upstream instead
 * ignores the suffix (#11703), which would hide release notes from hotfix builds.
 */
export function getNewEntries(entries: ChangelogEntry[], lastVersion: string): ChangelogEntry[] | undefined {
	const last = parseVersionToEntry(lastVersion);
	if (!last) return undefined;

	return entries.filter((entry) => compareVersions(entry, last) > 0);
}

function parseVersionToEntry(version: string): ChangelogEntry | undefined {
	const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
	if (!match) return undefined;
	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
		...(match[4] ? { prerelease: match[4] } : {}),
		content: "",
	};
}

/**
 * The release (major.minor.patch) part of a version string, dropping any prerelease or build
 * suffix, or undefined when it has no major.minor.patch. Extension changelogs compare against
 * the release so a prerelease extension version does not repeat its release's notes on every
 * launch (#11703); the agent's own changelog keeps the full version instead.
 */
export function releaseVersion(version: string): string | undefined {
	const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
	return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined;
}

// Re-export getChangelogPath from paths.ts for convenience
export { getChangelogPath } from "../config.ts";
