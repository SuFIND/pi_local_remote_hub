import { connect } from "node:net";
import { FrameReader, writeFrame, type ControlOp, type HubFrame } from "../extension/hubwire/frames.js";

/** One control request to a running hub over its local socket (used by the CLI). */
export function controlRequest(socketPath: string, op: ControlOp, args?: Record<string, unknown>, timeoutMs = 8_000): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		const reader = new FrameReader<HubFrame>();
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("Pi Remote Hub did not answer"));
		}, timeoutMs);
		const finish = (fn: () => void) => {
			clearTimeout(timer);
			socket.destroy();
			fn();
		};
		socket.once("connect", () => writeFrame(socket, { t: "control", rid: "cli", op, args }));
		socket.on("data", (chunk) => {
			for (const frame of reader.push(chunk)) {
				if (frame.t !== "controlResult") continue;
				if (frame.ok) finish(() => resolve(frame.result));
				else finish(() => reject(new Error(frame.error ?? "request failed")));
			}
		});
		socket.once("error", (error) => {
			const code = (error as NodeJS.ErrnoException).code;
			finish(() => reject(code === "ENOENT" || code === "ECONNREFUSED" ? new Error("Pi Remote Hub is not running") : error));
		});
	});
}
