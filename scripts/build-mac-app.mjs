#!/usr/bin/env node
// Builds the Pi Hub menu bar app (mac/PiHub) into "mac/build/Pi Hub.app".
//
//   node scripts/build-mac-app.mjs            build only
//   node scripts/build-mac-app.mjs --install  also replace ~/Applications/Pi Hub.app and open it
//
// The app starts the hub with the `node` running this script and this
// checkout's hub/bin.mjs, and gives the hub a PATH that reaches `pi`. Those
// paths are recorded in the app's Info.plist, so rebuild after moving the
// checkout or switching Node versions. Signs with an "Apple Development"
// identity when one is installed, otherwise ad hoc.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = join(root, "mac", "PiHub");
const appName = "Pi Hub";
const appDir = join(root, "mac", "build", `${appName}.app`);
const bundleId = process.env.PI_HUB_BUNDLE_ID ?? "io.github.sufind.PiHub";
const install = process.argv.includes("--install");

const run = (command, args, options = {}) =>
	execFileSync(command, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", timeout: 900_000, ...options }).trim();

console.log("Building mac/PiHub (release)…");
execFileSync("swift", ["build", "-c", "release", "--package-path", packageDir], { stdio: "inherit", timeout: 900_000 });
const binDir = run("swift", ["build", "-c", "release", "--package-path", packageDir, "--show-bin-path"]);

rmSync(appDir, { recursive: true, force: true });
mkdirSync(join(appDir, "Contents", "MacOS"), { recursive: true });
mkdirSync(join(appDir, "Contents", "Resources"), { recursive: true });
cpSync(join(binDir, "PiHub"), join(appDir, "Contents", "MacOS", "PiHub"));

// The Pi Remote app icon, copied from pi_local_remote_ios (Pi/Design/AppIcon-LiveSession.svg).
const iconSource = join(packageDir, "Resources", "AppIcon.png");
const hasIcon = existsSync(iconSource) && buildIcon(iconSource, join(appDir, "Contents", "Resources", "AppIcon.icns"));

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const build = run("git", ["-C", root, "rev-list", "--count", "HEAD"]) || "1";
const searchPath = hubSearchPath();
writeFileSync(
	join(appDir, "Contents", "Info.plist"),
	plist({
		CFBundleIdentifier: bundleId,
		CFBundleName: appName,
		CFBundleDisplayName: appName,
		CFBundleExecutable: "PiHub",
		CFBundlePackageType: "APPL",
		CFBundleShortVersionString: version.replace(/-.*/, ""),
		CFBundleVersion: build,
		...(hasIcon ? { CFBundleIconFile: "AppIcon" } : {}),
		LSMinimumSystemVersion: "26.0",
		LSUIElement: true,
		NSHumanReadableCopyright: "Pi Remote Hub menu bar app",
		PiHubNodePath: process.execPath,
		PiHubScriptPath: join(root, "hub", "bin.mjs"),
		PiHubSearchPath: searchPath,
	}),
);

const identity = signingIdentity();
run("codesign", ["--force", "--sign", identity ?? "-", "--timestamp=none", appDir]);
console.log(`Built ${appDir}`);
console.log(`  signed: ${identity ?? "ad hoc"}`);
console.log(`  node:   ${process.execPath}`);
console.log(`  hub:    ${join(root, "hub", "bin.mjs")}`);
console.log(`  PATH:   ${searchPath}`);

if (install) {
	const target = join(homedir(), "Applications", `${appName}.app`);
	// Quit the running copy normally so it stops the hub it started.
	try {
		execFileSync("osascript", ["-e", `if application id "${bundleId}" is running then tell application id "${bundleId}" to quit`], { stdio: "ignore", timeout: 15_000 });
	} catch {
		try {
			execFileSync("pkill", ["-x", "PiHub"], { stdio: "ignore" });
		} catch {
			// not running
		}
	}
	for (let i = 0; i < 50; i++) {
		try {
			execFileSync("pgrep", ["-x", "PiHub"], { stdio: "ignore" });
			await new Promise((resolve) => setTimeout(resolve, 200));
		} catch {
			break;
		}
	}
	mkdirSync(dirname(target), { recursive: true });
	rmSync(target, { recursive: true, force: true });
	execFileSync("ditto", [appDir, target]);
	execFileSync("open", [target]);
	console.log(`Installed and opened ${target}`);
}

/** PATH for the hub: node's folder, pi's folder, then the usual system ones. */
function hubSearchPath() {
	const dirs = [dirname(process.execPath)];
	try {
		const pi = run("/usr/bin/which", ["pi"]);
		if (pi) dirs.push(dirname(pi));
	} catch {
		console.warn("warning: `pi` is not on PATH; the hub may not be able to start Pi for the phone.");
	}
	dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin");
	return [...new Set(dirs)].join(":");
}

function signingIdentity() {
	try {
		const identities = run("security", ["find-identity", "-v", "-p", "codesigning"]);
		return identities.match(/"(Apple Development: [^"]+)"/)?.[1];
	} catch {
		return undefined;
	}
}

function buildIcon(source, destination) {
	const iconset = join(mkdtempSync(join(tmpdir(), "pihub-icon-")), "AppIcon.iconset");
	mkdirSync(iconset);
	try {
		for (const size of [16, 32, 128, 256, 512]) {
			run("sips", ["-z", `${size}`, `${size}`, source, "--out", join(iconset, `icon_${size}x${size}.png`)]);
			run("sips", ["-z", `${size * 2}`, `${size * 2}`, source, "--out", join(iconset, `icon_${size}x${size}@2x.png`)]);
		}
		run("iconutil", ["-c", "icns", iconset, "-o", destination]);
		return true;
	} catch (error) {
		console.warn(`warning: no app icon (${error instanceof Error ? error.message : error})`);
		return false;
	} finally {
		rmSync(dirname(iconset), { recursive: true, force: true });
	}
}

function plist(values) {
	const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const entries = Object.entries(values)
		.map(([key, value]) => `\t<key>${escape(key)}</key>\n\t${typeof value === "boolean" ? (value ? "<true/>" : "<false/>") : `<string>${escape(value)}</string>`}`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entries}
</dict>
</plist>
`;
}
