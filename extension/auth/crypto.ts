import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function createPairingCode(): string {
	const digits = String(Math.floor(100_000 + Math.random() * 900_000));
	return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

export function normalizePairingCode(code: string): string {
	const digits = code.replace(/\D/g, "");
	return digits.length === 6 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : code.trim();
}

export function createToken(): string {
	return randomBytes(32).toString("base64url");
}

export function createSecret(): string {
	return randomBytes(32).toString("base64url");
}

export function hashToken(token: string, secret: string): string {
	return createHash("sha256").update(token).update(":").update(secret).digest("base64url");
}

export function constantTimeEqualString(a: string, b: string): boolean {
	const ah = createHash("sha256").update(a).digest();
	const bh = createHash("sha256").update(b).digest();
	return timingSafeEqual(ah, bh);
}
