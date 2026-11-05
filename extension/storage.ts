import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Where Pi Remote keeps state that must survive a Pi restart: the TLS
 * identity, trusted devices, and settings. Defaults to
 * `<pi agent dir>/pi-remote` (`~/.pi/agent/pi-remote`). `PI_REMOTE_STATE_DIR`
 * overrides it — the E2E harness and tests use that to stay isolated.
 */
export function remoteStateDir(): string {
	const override = process.env.PI_REMOTE_STATE_DIR?.trim();
	return override ? override : join(getAgentDir(), "pi-remote");
}
