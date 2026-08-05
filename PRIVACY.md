# Privacy

Pi Remote has no accounts, analytics, advertising, telemetry, or developer-operated server.

## Session data

The iOS app exchanges session data directly with the Pi extension on your local network. This data can include:

- prompts and assistant responses;
- tool names, arguments, and output;
- commands and changed file paths;
- session metadata, such as the host, branch, model, and context usage;
- questions and answers.

Pi Remote does not send this data to the project maintainer. Pi sends model requests to the provider that you configured in Pi. That provider's privacy terms apply.

## Data stored on the iPhone

The app stores the device token, server URL, and paired device record in Keychain. Tap **Forget device** to remove them.

The app keeps its transcript and diagnostic envelope log in memory. It does not persist them as app records.

Continued-processing status and local notifications contain generic state only. They do not contain session content, commands, file paths, hostnames, or credentials.

## Data stored on the Pi host

The extension keeps token hashes, trusted-device records, pending questions, and run evidence in memory. Exiting Pi clears this data.

Pi stores its own session history according to Pi's configuration. Pi Remote does not change Pi's retention policy.

## Camera and local-network access

The in-app scanner uses the camera only to read a Pi Remote pairing QR code. VisionKit processes camera frames on the device. Pi Remote does not save or transmit camera images.

Local-network access connects the app to the Pi host. The connection uses authenticated, unencrypted `ws://` traffic.

Notification permission is optional. Denying it does not prevent foreground remote control.

## Network limits

Pi Remote has no cloud relay or APNs provider. The iPhone and Pi host must share a trusted local network.

A device that can intercept local traffic can read session content or steal the bearer token. Do not use Pi Remote on public Wi-Fi. Do not expose its port to the Internet.

## Deleting access

Use these controls when you no longer want the connection:

- Tap **Forget device** in the iOS app to remove its Keychain record.
- Run `/remote rotate` in Pi to revoke all trusted devices for that Pi process.
- Exit Pi to clear all extension trust records.

## Changes

Privacy changes appear in this file and the repository history.

## Contact

For a security issue, follow [`SECURITY.md`](SECURITY.md). For another privacy issue, open a GitHub issue without including session content or credentials.
