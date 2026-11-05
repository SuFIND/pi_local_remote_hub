import assert from "node:assert/strict";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { isAllowedPeerAddress, isPrivateIPv4, selectLanAddress } = jiti("../extension/net/lanAddress.ts");

const v4 = (address, internal = false) => ({ address, family: "IPv4", internal, netmask: "255.255.255.0", mac: "", cidr: null });
const v6 = (address) => ({ address, family: "IPv6", internal: false, netmask: "ffff::", mac: "", cidr: null, scopeid: 0 });

test("selectLanAddress prefers en0's private IPv4 and skips loopback, VPN and VM interfaces", () => {
	const address = selectLanAddress({
		lo0: [v4("127.0.0.1", true)],
		utun4: [v4("10.8.0.2")],
		bridge100: [v4("192.168.64.1")],
		en7: [v4("192.168.1.20")],
		en0: [v6("fe80::1"), v4("192.168.1.20")],
	});
	assert.equal(address, "192.168.1.20");
});

test("selectLanAddress falls back to another physical interface and ignores public or CGNAT addresses", () => {
	assert.equal(selectLanAddress({ en0: [v4("100.101.1.2")], en5: [v4("10.0.0.7")] }), "10.0.0.7");
	assert.equal(selectLanAddress({ en0: [v4("8.8.8.8")], tailscale0: [v4("10.1.1.1")] }), undefined);
	assert.equal(selectLanAddress({}), undefined);
});

test("isPrivateIPv4 covers exactly RFC 1918", () => {
	for (const address of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1"]) assert.equal(isPrivateIPv4(address), true, address);
	for (const address of ["172.15.0.1", "172.32.0.1", "192.169.0.1", "100.64.0.1", "8.8.8.8", "999.1.1.1", "a.b.c.d"]) {
		assert.equal(isPrivateIPv4(address), false, address);
	}
});

test("isAllowedPeerAddress admits loopback and private peers only", () => {
	for (const address of ["127.0.0.1", "::1", "::ffff:192.168.1.5", "10.2.3.4", "169.254.10.1", "fe80::1", "fd12::1"]) {
		assert.equal(isAllowedPeerAddress(address), true, address);
	}
	for (const address of [undefined, "", "8.8.8.8", "::ffff:1.1.1.1", "100.64.1.1", "2001:db8::1"]) {
		assert.equal(isAllowedPeerAddress(address), false, String(address));
	}
});
