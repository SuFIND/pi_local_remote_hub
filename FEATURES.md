# Product functionality

Pi Local Remote connects an iPhone to the Pi sessions on a computer on the same trusted local network. It provides remote supervision and control without changing Pi’s tool permissions or execution model. This repository holds the computer side; the iPhone app is in [pi_local_remote_ios](https://github.com/SuFIND/pi_local_remote_ios).

## Pi Remote Hub

- Runs as one resident process per Mac (foreground, or a launchd login item).
- Runs the authenticated TLS WebSocket server, binds the LAN address, and advertises it over Bonjour.
- Generates an expiring pairing code and QR link on request (`pair`).
- Lists the folders and Pi sessions inside the configured shared folders, live or saved, plus running-and-recent and search across all of them.
- Opens any of those sessions, answers history from disk while stopped, and starts Pi for it on demand.
- Starts new sessions in a shared folder; hub-started Pi exits after three idle minutes.
- Follows a Pi window across session switches and hands sessions over to a terminal that opens them.
- Shows a run driven from the phone live in a terminal that opens the same session, then reloads it when the run ends; two terminals on one session mirror each other the same way.
- Keeps each history answer under 4 MiB so long sessions load on the phone.

## Pi Hub menu bar app (macOS)

- Runs the hub in the background as a menu bar app without a Dock icon, and restarts it if it exits; quitting the app stops it. Optional Open at Login.
- Shows a "P" in the menu bar that marks a connected iPhone and a hub that is starting or down.
- Clicking it shows how many iPhones are paired and in use (connected now), what each connected one is viewing, and Pair iPhone; the rest is in a settings window (General, Shared Folders, iPhones, Pi Sessions), also opened by launching the app again.
- Shows the hub's address, certificate fingerprint and Bonjour state.
- Lists every running Pi: session name, folder, terminal or hub-started, working or idle, model, which iPhone is viewing it, and whether it is inside a shared folder.
- Stops a hub-started Pi on request (terminal windows are never stopped).
- Lists connected iPhones and what each is viewing; lists paired iPhones and revokes them.
- Shares and unshares folders, and sets the idle time after which hub-started Pi exits.
- Opens a pairing window with a QR code, the six-digit code and a countdown, and confirms when an iPhone paired.

## Pi extension

- Registers every Pi process with the hub over a local socket; never listens on the network.
- Adds `/remote pair`, `status`, `devices`, `revoke`, `rotate`, and `takeover` to Pi.
- Issues a one-time device token after successful pairing.
- Verifies returning devices by token and supports immediate trust rotation.
- Restricts unauthenticated connections to pairing, token authentication, and ping messages.
- Validates protocol versions, message types, payload sizes, authentication attempts, and connection limits.
- Exposes session state, transcript history, models, thinking levels, skills, and context usage.
- Accepts prompt, queue, steer, abort, compact, model, thinking-level, and question-answer commands.
- Expands explicit skill commands before sending them to Pi.
- Registers a `remote_question` tool for decisions that require user input.
- Preserves active questions across phone reconnects.
- Uses terminal input when a question starts while no phone is attached.
- Publishes structured session phases and execution context from Pi lifecycle events.
- Streams assistant, tool, and session events only to authenticated devices.
- Builds bounded completion evidence from tool metadata instead of assistant claims.
- Extracts edit diffs and synthesizes write diffs for changed-file review.
- Redacts known secret fields and limits event depth, string sizes, and array sizes.
- Uses heartbeat, authentication timeout, and controlled shutdown handling for connections.

## Scope and security

- Serves the Pi sessions on one computer; a phone drives one of them at a time.
- Requires the iPhone and Pi host to share a trusted local network.
- Encrypts traffic with TLS (`wss://`); the iPhone pins the hub's self-signed certificate.
- Grants terminal-equivalent control to a paired device.
- Does not add approval gates around Pi tools.
- Does not support queue editing or removal.
- Does not use APNs; background monitoring on the iPhone ends if iOS expires the task or the user removes the app from the app switcher.
