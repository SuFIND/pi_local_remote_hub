import assert from "node:assert/strict";
import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { certificateFingerprint, generateSelfSignedCertificate, shortFingerprint } = jiti("../extension/identity/certificate.ts");
const { loadOrCreateHostIdentity } = jiti("../extension/identity/HostIdentity.ts");

test("generateSelfSignedCertificate emits a valid self-signed P-256 server certificate", () => {
	const { certPem, keyPem } = generateSelfSignedCertificate({ commonName: "Pi Remote Test" });
	const cert = new X509Certificate(certPem);
	const key = createPrivateKey(keyPem);

	assert.equal(cert.subject, "CN=Pi Remote Test");
	assert.equal(cert.issuer, "CN=Pi Remote Test");
	assert.equal(cert.ca, false);
	assert.equal(cert.publicKey.asymmetricKeyType, "ec");
	assert.equal(cert.publicKey.asymmetricKeyDetails.namedCurve, "prime256v1");
	assert.equal(cert.checkPrivateKey(key), true);
	assert.equal(cert.verify(cert.publicKey), true);
	assert.deepEqual(cert.keyUsage, ["1.3.6.1.5.5.7.3.1"]);
	assert.equal(cert.subjectAltName, "DNS:pi-remote.local");
	assert.ok(new Date(cert.validTo).getTime() > Date.now() + 9 * 365 * 24 * 60 * 60_000);
	assert.ok(new Date(cert.validFrom).getTime() <= Date.now());
});

test("certificate validity past 2049 switches to GeneralizedTime", () => {
	const { certPem } = generateSelfSignedCertificate({ notBefore: new Date("2045-01-01T00:00:00Z"), validityDays: 3650 });
	const cert = new X509Certificate(certPem);
	assert.equal(new Date(cert.validTo).getUTCFullYear(), 2054);
	assert.equal(cert.verify(cert.publicKey), true);
});

test("certificateFingerprint is base64url SHA-256 of the DER bytes", () => {
	const { certPem } = generateSelfSignedCertificate();
	const expected = createHash("sha256").update(new X509Certificate(certPem).raw).digest("base64url");
	const fingerprint = certificateFingerprint(certPem);
	assert.equal(fingerprint, expected);
	assert.match(fingerprint, /^[A-Za-z0-9_-]{43}$/);
	assert.match(shortFingerprint(fingerprint), /^[0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4}$/);
	assert.equal(shortFingerprint(fingerprint).replaceAll(" ", ""), Buffer.from(fingerprint, "base64url").toString("hex").toUpperCase().slice(0, 16));
});

test("loadOrCreateHostIdentity persists one identity with private file modes", () => {
	const dir = join(mkdtempSync(join(tmpdir(), "pi-remote-identity-")), "state");
	try {
		const first = loadOrCreateHostIdentity(dir);
		const second = loadOrCreateHostIdentity(dir);
		assert.equal(second.fingerprint, first.fingerprint);
		assert.equal(statSync(dir).mode & 0o777, 0o700);
		assert.equal(statSync(join(dir, "tls-key.pem")).mode & 0o777, 0o600);
		assert.equal(readFileSync(join(dir, "tls-cert.pem"), "utf8"), first.certPem);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadOrCreateHostIdentity regenerates a corrupt or mismatched pair", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-remote-identity-"));
	try {
		const first = loadOrCreateHostIdentity(dir);
		writeFileSync(join(dir, "tls-key.pem"), generateSelfSignedCertificate().keyPem);
		const second = loadOrCreateHostIdentity(dir);
		assert.notEqual(second.fingerprint, first.fingerprint);
		assert.equal(new X509Certificate(second.certPem).checkPrivateKey(createPrivateKey(second.keyPem)), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
