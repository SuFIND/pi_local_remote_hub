# Privacy

Pi Local Remote has no accounts, analytics, advertising, telemetry, or developer-operated server.
The same policy applies to the hub ([pi_local_remote_hub](https://github.com/SuFIND/pi_local_remote_hub))
and the iPhone app ([pi_local_remote_ios](https://github.com/SuFIND/pi_local_remote_ios)).

## Session data

The iOS app exchanges session data directly with the Pi Remote Hub on your computer over the local network. This data can include:

- prompts and assistant responses;
- tool names, arguments, and output;
- commands and changed file paths;
- the names, folders and prompts of the Pi sessions inside the folders you share;
- session metadata, such as the host, branch, model, and context usage;
- questions and answers.

Pi Local Remote does not send this data to the project maintainer. Pi sends model requests to the provider that you configured in Pi. That provider's privacy terms apply.

## Data stored on the iPhone

The app stores the device token, server URL with the pinned certificate fingerprint, paired device record, and last opened folder in Keychain. Tap **Forget device** to remove them.

The app keeps its transcript and diagnostic envelope log in memory. It does not persist them as app records.

Continued-processing status and local notifications contain generic state only. They do not contain session content, commands, file paths, hostnames, or credentials.

## Data stored on the Pi host

The hub keeps its state in `~/.pi/agent/pi-remote/` (directory 0700, secrets 0600):

- `tls-key.pem` and `tls-cert.pem`: the hub's self-signed TLS identity;
- `trusted-devices.json`: a server secret and, for each paired iPhone, its name, last network address, timestamps and a hash of its token (never the token itself);
- `hub.json`: the shared folders and hub settings;
- `hub.log`: operational events such as started Pi processes, session file paths, connections, device names and network addresses. It does not record prompts, responses or tool output.

The hub reads Pi's session files to list and search sessions and keeps that index in memory; it never writes session files. Pending questions and run evidence stay in the memory of the Pi process.

Pi stores its own session history according to Pi's configuration. Pi Local Remote does not change Pi's retention policy.

## Camera and local-network access

The in-app scanner uses the camera only to read a Pi Remote pairing QR code. VisionKit processes camera frames on the device. Pi Local Remote does not save or transmit camera images.

Local-network access connects the app to the hub and finds it over Bonjour. The connection uses TLS (`wss://`), and the app pins the hub's certificate.

Notification permission is optional. Denying it does not prevent foreground remote control.

## Network limits

Pi Local Remote has no cloud relay or APNs provider. The iPhone and Pi host must share a trusted local network.

A paired device has terminal-equivalent control of the computer. Do not expose the hub's port to the Internet or forward it through a tunnel.

## Deleting access

Use these controls when you no longer want the connection:

- Tap **Forget device** in the iOS app to remove its Keychain record.
- Revoke the iPhone under **iPhones** in Pi Hub, or run `/remote revoke <id>` in Pi.
- Run `/remote rotate` in Pi to revoke every trusted device.
- Delete `~/.pi/agent/pi-remote/` to remove the hub's identity, trusted devices, settings and log.

## Changes

Privacy changes appear in this file and the repository history.

## Contact

For a security issue, follow [`SECURITY.md`](SECURITY.md). For another privacy issue, open a GitHub issue without including session content or credentials.
