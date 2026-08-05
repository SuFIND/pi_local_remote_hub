#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import WebSocket from "ws";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const port = Number(process.env.PI_LINUX_E2E_PORT ?? 3773);
const containerName = `pi-remote-linux-e2e-${process.pid}`;
const dockerCommand = [
  "run", "--rm", "-i",
  "--name", containerName,
  "-p", `${port}:${port}`,
  "-v", `${root}:/source:ro`,
  "node:22-bookworm",
  "bash", "-lc",
  `set -euo pipefail
mkdir -p /work
cd /source
tar --exclude=.git --exclude=node_modules --exclude=Derived --exclude=Pi.xcodeproj --exclude=Pi.xcworkspace -cf - . | tar -C /work -xf -
cd /work
npm ci --ignore-scripts --no-audit --no-fund >/dev/null
exec ./node_modules/.bin/pi --mode rpc --no-session --no-extensions --extension ./extension/index.ts --no-skills --no-prompt-templates --no-context-files --offline`,
];

const child = spawn("docker", dockerCommand, {
  cwd: root,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (chunk) => process.stderr.write(`[linux] ${chunk}`));

let pairingCode;
let commandResolved = false;
let rejectCommand;
let commandTimer;
const command = new Promise((resolve, reject) => {
  rejectCommand = reject;
  commandTimer = setTimeout(() => reject(new Error("Linux Pi startup timed out")), 180_000);
  attachJSONLines(child.stdout, (message) => {
    if (message.type === "extension_ui_request" && message.method === "notify") {
      pairingCode ??= message.message?.match(/^Pairing code: ([0-9-]+)$/m)?.[1];
    }
    if (message.type === "response" && message.id === "linux_start") {
      clearTimeout(commandTimer);
      commandResolved = true;
      if (message.success) resolve();
      else reject(new Error(message.error ?? "Linux /remote start failed"));
    }
  });
});

child.once("exit", (code, signal) => {
  if (!commandResolved) {
    clearTimeout(commandTimer);
    rejectCommand(new Error(`Linux container exited with code ${code ?? "null"}, signal ${signal ?? "none"}`));
  }
});
child.stdin.write(`${JSON.stringify({
  id: "linux_start",
  type: "prompt",
  message: `/remote start --host 0.0.0.0 --port ${port}`,
})}\n`);

try {
  await command;
  if (!pairingCode) throw new Error("Linux Pi did not return a pairing code");

  const first = await openSocket(`ws://127.0.0.1:${port}/v1/ws`);
  const hello = await first.next("server.hello");
  if (!hello.payload.capabilities.events.includes("pi.agent_settled")) {
    throw new Error("Linux server omitted pi.agent_settled capability");
  }
  if (hello.payload.auth.pairingAvailable !== true) {
    throw new Error("Linux server did not expose the pairing window");
  }

  first.send({
    id: "pair_linux",
    type: "auth.pair.request",
    protocolVersion: 1,
    payload: { code: pairingCode, deviceName: "Linux E2E" },
  });
  const pairSuccess = await first.next("auth.pair.success");
  await first.next("state.snapshot");
  if (!pairSuccess.payload.token) throw new Error("Linux pairing returned no token");
  first.close();

  const second = await openSocket(`ws://127.0.0.1:${port}/v1/ws`);
  await second.next("server.hello");
  second.send({
    id: "token_linux",
    type: "auth.token",
    protocolVersion: 1,
    payload: { token: pairSuccess.payload.token },
  });
  await second.next("auth.token.success");
  await second.next("state.snapshot");
  second.close();

  console.log("Linux E2E passed: extension load, LAN bind, pairing, state, and token reconnect");
} finally {
  child.kill("SIGTERM");
  spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
}

function attachJSONLines(stream, onMessage) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      handle(buffer.slice(0, newline).replace(/\r$/, ""));
      buffer = buffer.slice(newline + 1);
    }
  });
  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer) handle(buffer.replace(/\r$/, ""));
  });

  function handle(line) {
    if (!line) return;
    try {
      onMessage(JSON.parse(line));
    } catch {
      process.stderr.write(`[linux stdout] ${line}\n`);
    }
  }
}

async function openSocket(url) {
  const socket = new WebSocket(url);
  const queued = [];
  const waiting = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    const waiter = waiting.find((candidate) => candidate.type === message.type);
    if (waiter) {
      waiting.splice(waiting.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      queued.push(message);
    }
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  return {
    next(type, timeoutMs = 10_000) {
      const existing = queued.find((message) => message.type === type);
      if (existing) {
        queued.splice(queued.indexOf(existing), 1);
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const waiter = { type, resolve, reject };
        waiter.timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for ${type}`));
        }, timeoutMs);
        waiting.push(waiter);
      });
    },
    send(value) {
      socket.send(JSON.stringify(value));
    },
    close() {
      socket.close();
    },
  };
}
