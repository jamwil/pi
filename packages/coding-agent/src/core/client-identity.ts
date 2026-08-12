import { type ClientIdentity, PI_ATTRIBUTION } from "@earendil-works/pi-ai";
import { VERSION } from "../config.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { isInstallTelemetryEnabled } from "./telemetry.ts";

/**
 * How pi's requests identify it to providers: a detailed `User-Agent` with pi's version, and attribution to pi as a
 * CLI agent while install telemetry is enabled.
 */
export function getClientIdentity(_settingsManager: SettingsManager): ClientIdentity {
	return {
		userAgent: "detailed",
		version: VERSION,
		attribution: isInstallTelemetryEnabled() ? PI_ATTRIBUTION : null,
	};
}
