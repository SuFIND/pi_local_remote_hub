import { isIP } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/**
 * LAN-only exposure helpers. Pi Remote binds one private IPv4 address (the
 * Wi-Fi / Ethernet interface) instead of `0.0.0.0`, so the listener is never
 * reachable through VPN, tunnel, bridge, or VM interfaces, and rejects peers
 * that are not on a private network.
 */

export type InterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>;

/** Interfaces that are never "the LAN": VPN/tunnels, VM/container bridges, AirDrop. */
const EXCLUDED_INTERFACE = /^(utun|ipsec|ppp|tun|tap|gif|stf|awdl|llw|anpi|bridge|vmnet|vboxnet|docker|br-|veth|virbr|zt|tailscale|wg)/i;

/** Pick the address to listen on: a private IPv4 on a physical interface, `en0` first. */
export function selectLanAddress(interfaces: InterfaceMap = networkInterfaces()): string | undefined {
	const candidates: { name: string; address: string }[] = [];
	for (const [name, entries] of Object.entries(interfaces)) {
		if (!entries || EXCLUDED_INTERFACE.test(name)) continue;
		for (const entry of entries) {
			if (entry.internal || entry.family !== "IPv4") continue;
			if (!isPrivateIPv4(entry.address)) continue;
			candidates.push({ name, address: entry.address });
		}
	}
	candidates.sort((a, b) => interfaceRank(a.name) - interfaceRank(b.name) || a.name.localeCompare(b.name, "en"));
	return candidates[0]?.address;
}

/** Peers allowed to open a socket: loopback, RFC 1918, link-local, IPv6 ULA. */
export function isAllowedPeerAddress(address: string | undefined): boolean {
	if (!address) return false;
	const normalized = address.toLowerCase().replace(/^::ffff:/, "");
	if (isIP(normalized) === 4) return normalized.startsWith("127.") || isPrivateIPv4(normalized) || normalized.startsWith("169.254.");
	if (isIP(normalized) === 6) {
		return normalized === "::1" || /^fe[89ab]/.test(normalized) || /^f[cd]/.test(normalized);
	}
	return false;
}

/** True for a concrete loopback host (`127.x`, `::1`, `localhost`). */
export function isLoopbackHost(host: string): boolean {
	return host.startsWith("127.") || host === "::1" || host === "localhost";
}

export function isPrivateIPv4(address: string): boolean {
	const octets = address.split(".").map(Number);
	if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
	const [a, b] = octets;
	return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function interfaceRank(name: string): number {
	if (name === "en0") return 0;
	if (/^(en|eth|eno|enp|ens|wlan|wlp|wl)/.test(name)) return 1;
	return 2;
}
