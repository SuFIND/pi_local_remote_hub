# Product functionality

Pi Remote connects an iOS device to one active Pi terminal session on the same trusted local network. It provides remote supervision and control without changing Pi’s tool permissions or execution model.

## iOS app

- Pairs with a running Pi session by scanning its QR code in the app or entering its host URL and six-digit code.
- Stores the issued device token in Keychain for later authenticated reconnects.
- Restores session state, transcript history, and pending questions after reconnecting.
- Opens on running and recent sessions across the shared folders, then the shared folders themselves.
- Shows a shared folder as its own sessions plus a collapsible tree of the projects inside it; levels without sessions fold into one row, and folders with no sessions at all stay under "Other Folders".
- Searches sessions by name, prompts and folder, with the matching text quoted.
- Sends prompts to the active session.
- Queues a prompt for later delivery or steers the current run while Pi is busy.
- Aborts the current run and requests session compaction.
- Tracks structured session phases, including running, queued, needs input, compacting, completed, and failed.
- Tracks the connected host, working directory, Git branch, model, thinking level, and context usage when available.
- Lists available models and changes the active model and thinking level.
- Lists Pi skills and invokes them in the active host session.
- Receives assistant output and tool execution events as they occur.
- Answers reconnect-safe questions raised by Pi.
- Receives structured completion evidence, including command outcomes, tool failures, changed files, and line counts.
- Retains edit and write diffs for review when the extension provides them.
- Reconnects after temporary network loss with bounded backoff and keepalive checks.
- Uses an iOS 26 continued-processing task to monitor a user-started run after minimization.
- Sends generic local notifications when Pi needs input or completes a monitored run.
- Keeps prompts, responses, commands, paths, and credentials out of system activity and notification content.
- Keeps sensitive session content out of stored diagnostic records.

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

- Controls one active Pi session in the current Pi process.
- Requires the iPhone and Pi host to share a trusted local network.
- Uses authenticated but unencrypted `ws://` traffic on the local network.
- Grants terminal-equivalent control to a paired device.
- Does not add approval gates around Pi tools.
- Does not support queue editing or removal.
- Does not provide multi-host or multi-session management.
- Does not use APNs; background monitoring ends if iOS expires the task or the user removes the app from the app switcher.
