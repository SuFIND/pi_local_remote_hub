# Product functionality

Pi Remote connects an iOS device to one active Pi terminal session on the same trusted local network. It provides remote supervision and control without changing Pi’s tool permissions or execution model.

## iOS app

- Pairs with a running Pi session by using a six-digit code or pairing link.
- Stores the issued device token in Keychain for later authenticated reconnects.
- Restores session state, transcript history, and pending questions after reconnecting.
- Sends prompts to the active session.
- Queues a prompt for later delivery or steers the current run while Pi is busy.
- Aborts the current run and requests session compaction.
- Tracks structured session phases, including running, queued, needs input, compacting, completed, and failed.
- Tracks the connected Mac, working directory, Git branch, model, thinking level, and context usage when available.
- Lists available models and changes the active model and thinking level.
- Lists Pi skills and invokes them in the active Mac session.
- Receives assistant output and tool execution events as they occur.
- Answers reconnect-safe questions raised by Pi.
- Receives structured completion evidence, including command outcomes, tool failures, changed files, and line counts.
- Retains edit and write diffs for review when the extension provides them.
- Reconnects after temporary network loss with bounded backoff and keepalive checks.
- Uses an iOS 26 continued-processing task to monitor a user-started run after minimization.
- Sends generic local notifications when Pi needs input or completes a monitored run.
- Keeps prompts, responses, commands, paths, and credentials out of system activity and notification content.
- Keeps sensitive session content out of stored diagnostic records.

## Pi extension

- Adds the `/remote start`, `/remote stop`, `/remote status`, and `/remote rotate` commands to Pi.
- Runs an authenticated WebSocket server for the active Pi process.
- Binds to the local network by default and advertises the Mac’s LAN address.
- Generates an expiring pairing code and pairing link when remote control starts.
- Issues a one-time device token after successful pairing.
- Verifies returning devices by token and supports immediate trust rotation.
- Restricts unauthenticated connections to pairing, token authentication, and ping messages.
- Validates protocol versions, message types, payload sizes, authentication attempts, and connection limits.
- Exposes session state, transcript history, models, thinking levels, skills, and context usage.
- Accepts prompt, queue, steer, abort, compact, model, thinking-level, and question-answer commands.
- Expands explicit skill commands before sending them to Pi.
- Registers a `remote_question` tool for decisions that require user input.
- Preserves active questions across phone reconnects.
- Uses terminal input when a question starts while remote control is stopped.
- Publishes structured session phases and execution context from Pi lifecycle events.
- Streams assistant, tool, and session events only to authenticated devices.
- Builds bounded completion evidence from tool metadata instead of assistant claims.
- Extracts edit diffs and synthesizes write diffs for changed-file review.
- Redacts known secret fields and limits event depth, string sizes, and array sizes.
- Uses heartbeat, authentication timeout, and controlled shutdown handling for connections.

## Scope and security

- Controls one active Pi session in the current Pi process.
- Requires the iPhone and Mac to share a trusted local network.
- Uses authenticated but unencrypted `ws://` traffic on the local network.
- Grants terminal-equivalent control to a paired device.
- Does not add approval gates around Pi tools.
- Does not support queue editing or removal.
- Does not provide multi-host or multi-session management.
- Does not use APNs; background monitoring ends if iOS expires the task or the user removes the app from the app switcher.
