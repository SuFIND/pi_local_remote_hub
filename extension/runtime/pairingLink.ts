import qrcode from "qrcode-terminal";

/**
 * Builds the deep-link URI a paired iOS client can scan from the QR code
 * printed by `/remote start`.
 *
 * Format:
 *   pi-remote://pair?url=<percent-encoded ws url>&code=<6-digit-code>
 *
 * The URL and code are the same values shown in the textual `/remote start`
 * status block — the QR is a UX convenience, not a separate credential.
 */
export const PAIRING_LINK_SCHEME = "pi-remote";

export function buildPairingDeepLink(webSocketUrl: string, pairingCode: string): string {
	if (!webSocketUrl) throw new Error("buildPairingDeepLink requires a non-empty webSocketUrl");
	if (!pairingCode) throw new Error("buildPairingDeepLink requires a non-empty pairingCode");
	const params = new URLSearchParams({ url: webSocketUrl, code: pairingCode });
	return `${PAIRING_LINK_SCHEME}://pair?${params.toString()}`;
}

/**
 * Renders a deep link as an ASCII QR code suitable for terminal display.
 * Uses half-block characters to keep the QR roughly square in typical
 * terminal cell aspect ratios.
 */
export function renderPairingQrCode(deepLink: string): Promise<string> {
	return new Promise((resolve) => {
		qrcode.generate(deepLink, { small: true }, (output) => resolve(output));
	});
}
