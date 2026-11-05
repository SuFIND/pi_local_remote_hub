import { createPrivateKey, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { certificateFingerprint, generateSelfSignedCertificate, shortFingerprint } from "./certificate.js";

/**
 * The listener's long-lived TLS identity. One per Pi agent directory, shared
 * by every Pi process on this Mac, so a phone paired once pins one
 * fingerprint no matter which Pi window (or port, or LAN IP) it lands on.
 */
export type HostIdentity = {
	keyPem: string;
	certPem: string;
	/** SHA-256 of the certificate DER, base64url (43 chars). */
	fingerprint: string;
	/** `AB12 CD34 EF56 7890` — first 64 bits, for eyeball comparison. */
	fingerprintShort: string;
};

const KEY_FILE = "tls-key.pem";
const CERT_FILE = "tls-cert.pem";

export function createHostIdentity(): HostIdentity {
	const { certPem, keyPem } = generateSelfSignedCertificate();
	return identityFrom(certPem, keyPem);
}

/**
 * Load `<dir>/tls-{key,cert}.pem`, generating them on first use. The key is
 * written 0600 inside a 0700 directory. A missing, unreadable, or mismatched
 * pair is regenerated (paired phones will then refuse the new fingerprint
 * and need to pair again — that is the point of pinning).
 */
export function loadOrCreateHostIdentity(dir: string): HostIdentity {
	ensurePrivateDir(dir);
	const keyPath = join(dir, KEY_FILE);
	const certPath = join(dir, CERT_FILE);
	if (existsSync(keyPath) && existsSync(certPath)) {
		try {
			const keyPem = readFileSync(keyPath, "utf8");
			const certPem = readFileSync(certPath, "utf8");
			if (new X509Certificate(certPem).checkPrivateKey(createPrivateKey(keyPem))) {
				return identityFrom(certPem, keyPem);
			}
		} catch {
			// Fall through and regenerate.
		}
	}
	const identity = createHostIdentity();
	writePrivateFile(keyPath, identity.keyPem);
	writePrivateFile(certPath, identity.certPem);
	return identity;
}

export function ensurePrivateDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(dir, 0o700);
	} catch {
		// Best effort (e.g. a directory we don't own).
	}
}

/** Atomic replace: write a 0600 temp file next to the target, then rename. */
export function writePrivateFile(path: string, contents: string): void {
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temp, contents, { mode: 0o600 });
	renameSync(temp, path);
}

function identityFrom(certPem: string, keyPem: string): HostIdentity {
	const fingerprint = certificateFingerprint(certPem);
	return { keyPem, certPem, fingerprint, fingerprintShort: shortFingerprint(fingerprint) };
}
