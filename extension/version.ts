import { readFileSync } from "node:fs";

/** This package's version from package.json, e.g. "0.1.0" ("0.0.0" if unreadable). */
export const PACKAGE_VERSION: string = readPackageVersion();

function readPackageVersion(): string {
	try {
		const parsed: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		const version = parsed && typeof parsed === "object" ? (parsed as { version?: unknown }).version : undefined;
		return typeof version === "string" ? version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}
