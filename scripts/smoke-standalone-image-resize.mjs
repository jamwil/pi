#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const standaloneDir = process.argv[2];
if (!standaloneDir) {
	throw new Error("Usage: node scripts/smoke-standalone-image-resize.mjs <standalone-dir>");
}

const resolvedStandaloneDir = path.resolve(standaloneDir);
const workerPath = path.join(resolvedStandaloneDir, "image-resize-worker.js");
const wasmPath = path.join(resolvedStandaloneDir, "photon_rs_bg.wasm");
for (const requiredPath of [workerPath, wasmPath]) {
	if (!existsSync(requiredPath)) {
		throw new Error(`Missing standalone image asset: ${requiredPath}`);
	}
}

const tinyPng = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gEOADM5Ddoh/wAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMOnKzHgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDCYl3TEAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAwz4JVGwAAAABJRU5ErkJggg==",
	"base64",
);
const worker = new Worker(pathToFileURL(workerPath));
try {
	const response = await new Promise((resolve, reject) => {
		worker.once("message", resolve);
		worker.once("error", reject);
		worker.once("exit", (code) => {
			if (code !== 0) reject(new Error(`Standalone image resize worker exited with code ${code}`));
		});
		worker.postMessage({
			inputBytes: new Uint8Array(tinyPng),
			mimeType: "image/png",
			options: { maxWidth: 1, maxHeight: 1, maxBytes: 1024 * 1024 },
		});
	});

	if (!response || typeof response !== "object") {
		throw new Error("Standalone image resize worker returned an invalid response");
	}
	if ("error" in response && response.error) {
		throw new Error(`Standalone image resize worker failed: ${String(response.error)}`);
	}
	if (!("result" in response) || !response.result || typeof response.result !== "object") {
		throw new Error("Standalone image resize worker could not resize the image");
	}

	const result = response.result;
	if (!("width" in result) || result.width !== 1 || !("height" in result) || result.height !== 1) {
		throw new Error("Standalone image resize worker returned unexpected dimensions");
	}
	if (!("wasResized" in result) || result.wasResized !== true) {
		throw new Error("Standalone image resize worker did not report resizing the image");
	}
	if (!("data" in result) || typeof result.data !== "string") {
		throw new Error("Standalone image resize worker returned invalid image data");
	}
	const resizedBytes = Buffer.from(result.data, "base64");
	if (!resizedBytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
		throw new Error("Standalone image resize worker did not return a PNG");
	}
} finally {
	await worker.terminate();
}

console.log("STANDALONE_IMAGE_RESIZE=passed");
