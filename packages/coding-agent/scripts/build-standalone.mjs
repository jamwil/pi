import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(packageDir, "dist", "standalone");
const outputFile = path.join(outputDir, "cli.mjs");
const imageResizeWorkerOutputFile = path.join(outputDir, "image-resize-worker.js");
const codemodeWorkerOutputFile = path.join(outputDir, "codemode-worker.js");
const packageJsonPath = path.join(packageDir, "package.json");
const photonWasmPath = require.resolve("@silvia-odwyer/photon-node/photon_rs_bg.wasm");
const quickjsWasmPath = require.resolve("quickjs-wasi/quickjs.wasm");
const esmCommonJsBanner = [
	'import { createRequire as __createRequire } from "node:module";',
	'import { dirname as __pathDirname } from "node:path";',
	'import { fileURLToPath as __fileURLToPath } from "node:url";',
	"const require = __createRequire(import.meta.url);",
	"const __filename = __fileURLToPath(import.meta.url);",
	"const __dirname = __pathDirname(__filename);",
].join(" ");

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const buildResults = await Promise.all([
	build({
		entryPoints: [path.join(packageDir, "dist", "bun", "cli.js")],
		bundle: true,
		platform: "node",
		target: "node24",
		format: "esm",
		outfile: outputFile,
		metafile: true,
		legalComments: "none",
		define: { "process.env.PI_STANDALONE_BUNDLE": '"1"' },
		logOverride: { "ignored-bare-import": "silent" },
		banner: { js: esmCommonJsBanner },
		plugins: [
			{
				// `src/bun/runtime-setup.ts` imports `quickjs-wasi/quickjs.wasm` and Bun
				// evaluates that to a readable path. In the standalone bundle, resolve it to
				// the wasm file copied beside the CLI at runtime instead of loading the binary.
				name: "standalone-quickjs-wasm",
				setup(buildContext) {
					buildContext.onResolve({ filter: /^quickjs-wasi\/quickjs\.wasm$/ }, () => ({
						path: "quickjs-wasi/quickjs.wasm",
						namespace: "standalone-quickjs-wasm",
					}));
					buildContext.onLoad({ filter: /.*/, namespace: "standalone-quickjs-wasm" }, () => ({
						contents: [
							// The import alias must not collide with the banner's aliases
							// (e.g. `__fileURLToPath`): esbuild does not scope-track banner
							// text, so a colliding module-scope import becomes a duplicate
							// declaration that breaks parsing of the whole bundle.
							'import { fileURLToPath as __quickjsWasmFileURLToPath } from "node:url";',
							'export default __quickjsWasmFileURLToPath(new URL("./quickjs.wasm", import.meta.url));',
						].join("\n"),
						loader: "js",
					}));
				},
			},
			{
				name: "disable-optional-modules",
				setup(buildContext) {
					buildContext.onResolve(
						// kerberos is an optional peer of proxy-agent-negotiate (Negotiate
						// proxy auth); it is guarded at runtime with an install hint when used.
						{ filter: /^(bufferutil|kerberos|supports-color|utf-8-validate)$/ },
						({ path: specifier }) => ({
							path: specifier,
							namespace: "standalone-optional-module",
						}),
					);
					buildContext.onLoad(
						{ filter: /.*/, namespace: "standalone-optional-module" },
						({ path: specifier }) => ({
							contents: `throw new Error(${JSON.stringify(`${specifier} is not included in the standalone build`)});`,
							loader: "js",
						}),
					);
				},
			},
		],
	}),
	build({
		entryPoints: [path.join(packageDir, "dist", "utils", "image-resize-worker.js")],
		bundle: true,
		platform: "node",
		target: "node24",
		format: "esm",
		outfile: imageResizeWorkerOutputFile,
		metafile: true,
		legalComments: "none",
		banner: { js: esmCommonJsBanner },
	}),
	build({
		entryPoints: [path.join(packageDir, "dist", "extensions", "codemode", "worker.js")],
		bundle: true,
		platform: "node",
		target: "node24",
		format: "esm",
		outfile: codemodeWorkerOutputFile,
		metafile: true,
		legalComments: "none",
		banner: { js: esmCommonJsBanner },
	}),
]);

const builtins = new Set(builtinModules);
const externalImports = buildResults
	.flatMap((result) => Object.values(result.metafile.outputs))
	.flatMap((output) => output.imports)
	.filter(
		(imported) =>
			imported.external && !imported.path.startsWith("node:") && !builtins.has(imported.path),
	);
if (externalImports.length > 0) {
	throw new Error(
		`Standalone bundle has external package imports: ${[...new Set(externalImports.map(({ path }) => path))].join(", ")}`,
	);
}

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
await writeFile(
	path.join(outputDir, "package.json"),
	`${JSON.stringify(
		{
			name: packageJson.name,
			version: packageJson.version,
			type: "module",
			piConfig: packageJson.piConfig,
		},
		null,
		2,
	)}\n`,
);

const themeOutputDir = path.join(outputDir, "dist", "modes", "interactive", "theme");
await mkdir(themeOutputDir, { recursive: true });
for (const theme of ["dark.json", "light.json"]) {
	await cp(path.join(packageDir, "src", "modes", "interactive", "theme", theme), path.join(themeOutputDir, theme));
}

const exportTemplateOutputDir = path.join(outputDir, "dist", "core", "export-html");
await mkdir(exportTemplateOutputDir, { recursive: true });
for (const template of ["template.html", "template.css", "template.js"]) {
	await cp(path.join(packageDir, "src", "core", "export-html", template), path.join(exportTemplateOutputDir, template));
}
await cp(
	path.join(packageDir, "src", "core", "export-html", "vendor"),
	path.join(exportTemplateOutputDir, "vendor"),
	{ recursive: true },
);

// Photon loads its WASM at runtime. Keep one shared asset beside the CLI and worker
// instead of embedding the same 1.8 MB payload in both bundles.
await cp(photonWasmPath, path.join(outputDir, path.basename(photonWasmPath)));

// Codemode reads the QuickJS wasm beside the CLI (getQuickJSWasmPath in config.ts).
await cp(quickjsWasmPath, path.join(outputDir, path.basename(quickjsWasmPath)));

await chmod(outputFile, 0o755);
console.log(`Built standalone Node CLI at ${path.relative(packageDir, outputFile)}`);
