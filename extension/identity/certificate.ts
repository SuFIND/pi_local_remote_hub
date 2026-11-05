import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";

/**
 * Self-signed TLS identity for the LAN listener.
 *
 * Node ships no X.509 *writer*, so this file carries a tiny DER encoder for
 * exactly one certificate shape: ECDSA P-256 / SHA-256, CN only, CA:false,
 * serverAuth. Clients never evaluate it against a trust store — they pin the
 * SHA-256 of the DER bytes (see `certificateFingerprint`) — so the fields only
 * have to be well-formed, not publicly trusted.
 */

export type GeneratedCertificate = {
	certPem: string;
	keyPem: string;
};

export type CertificateOptions = {
	commonName?: string;
	notBefore?: Date;
	validityDays?: number;
};

const DEFAULT_COMMON_NAME = "Pi Remote";
const DEFAULT_VALIDITY_DAYS = 3650;

const OID = {
	ecdsaWithSha256: "1.2.840.10045.4.3.2",
	commonName: "2.5.4.3",
	basicConstraints: "2.5.29.19",
	keyUsage: "2.5.29.15",
	extKeyUsage: "2.5.29.37",
	subjectAltName: "2.5.29.17",
	serverAuth: "1.3.6.1.5.5.7.3.1",
} as const;

export function generateSelfSignedCertificate(options: CertificateOptions = {}): GeneratedCertificate {
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const certDer = buildCertificateDer({
		privateKey,
		publicKey,
		commonName: options.commonName ?? DEFAULT_COMMON_NAME,
		notBefore: options.notBefore ?? new Date(Date.now() - 60 * 60_000),
		validityDays: options.validityDays ?? DEFAULT_VALIDITY_DAYS,
	});
	return {
		certPem: toPem("CERTIFICATE", certDer),
		keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
	};
}

/**
 * Canonical pin: SHA-256 over the leaf certificate's DER bytes, base64url
 * without padding (43 chars). The iOS client computes the same value from
 * `SecCertificateCopyData`.
 */
export function certificateFingerprint(certPem: string): string {
	return createHash("sha256").update(new X509Certificate(certPem).raw).digest("base64url");
}

/** Human-comparable form shown in the terminal and on the phone: first 64 bits, hex, grouped. */
export function shortFingerprint(fingerprint: string): string {
	const hex = Buffer.from(fingerprint, "base64url").toString("hex").toUpperCase().slice(0, 16);
	return hex.match(/.{1,4}/g)?.join(" ") ?? hex;
}

// MARK: - Certificate assembly

function buildCertificateDer(input: {
	privateKey: KeyObject;
	publicKey: KeyObject;
	commonName: string;
	notBefore: Date;
	validityDays: number;
}): Buffer {
	const signatureAlgorithm = sequence(oid(OID.ecdsaWithSha256));
	const name = sequence(set(sequence(oid(OID.commonName), utf8String(input.commonName))));
	const notAfter = new Date(input.notBefore.getTime() + input.validityDays * 24 * 60 * 60_000);
	const serial = randomBytes(16);
	serial[0] &= 0x7f;

	const extensions = sequence(
		extension(OID.basicConstraints, true, sequence()),
		// digitalSignature only: one byte, seven unused bits.
		extension(OID.keyUsage, true, tlv(0x03, Buffer.from([0x07, 0x80]))),
		extension(OID.extKeyUsage, false, sequence(oid(OID.serverAuth))),
		extension(OID.subjectAltName, false, sequence(tlv(0x82, Buffer.from("pi-remote.local", "ascii")))),
	);

	const tbs = sequence(
		explicit(0, integer(Buffer.from([2]))),
		integer(serial),
		signatureAlgorithm,
		name,
		sequence(time(input.notBefore), time(notAfter)),
		name,
		input.publicKey.export({ type: "spki", format: "der" }),
		explicit(3, extensions),
	);
	const signature = sign("sha256", tbs, input.privateKey);
	return sequence(tbs, signatureAlgorithm, bitString(signature));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
	return critical ? sequence(oid(id), boolean(true), octetString(value)) : sequence(oid(id), octetString(value));
}

function toPem(label: string, der: Buffer): string {
	const body = der.toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
	return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

// MARK: - Minimal DER encoder

function tlv(tag: number, content: Buffer): Buffer {
	return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

function encodeLength(length: number): Buffer {
	if (length < 0x80) return Buffer.from([length]);
	const bytes: number[] = [];
	for (let value = length; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 0xff);
	return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function sequence(...items: Buffer[]): Buffer {
	return tlv(0x30, Buffer.concat(items));
}

function set(...items: Buffer[]): Buffer {
	return tlv(0x31, Buffer.concat(items));
}

function explicit(tagNumber: number, content: Buffer): Buffer {
	return tlv(0xa0 + tagNumber, content);
}

function integer(value: Buffer): Buffer {
	let bytes = value;
	while (bytes.length > 1 && bytes[0] === 0 && (bytes[1] & 0x80) === 0) bytes = bytes.subarray(1);
	if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
	return tlv(0x02, bytes);
}

function boolean(value: boolean): Buffer {
	return tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
}

function octetString(value: Buffer): Buffer {
	return tlv(0x04, value);
}

function bitString(value: Buffer): Buffer {
	return tlv(0x03, Buffer.concat([Buffer.from([0]), value]));
}

function utf8String(value: string): Buffer {
	return tlv(0x0c, Buffer.from(value, "utf8"));
}

function oid(dotted: string): Buffer {
	const parts = dotted.split(".").map(Number);
	const bytes = [40 * parts[0] + parts[1]];
	for (const part of parts.slice(2)) {
		const chunk = [part & 0x7f];
		for (let value = Math.floor(part / 128); value > 0; value = Math.floor(value / 128)) chunk.unshift((value & 0x7f) | 0x80);
		bytes.push(...chunk);
	}
	return tlv(0x06, Buffer.from(bytes));
}

function time(date: Date): Buffer {
	const pad = (value: number) => String(value).padStart(2, "0");
	const year = date.getUTCFullYear();
	const rest = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
	// RFC 5280 §4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050.
	if (year >= 1950 && year < 2050) return tlv(0x17, Buffer.from(`${String(year).slice(2)}${rest}`, "ascii"));
	return tlv(0x18, Buffer.from(`${year}${rest}`, "ascii"));
}
