# Security policy

Pi Local Remote lets a paired iPhone submit prompts to the Pi sessions on your computer. Treat access as
equivalent to terminal access under the account running Pi.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting page:

https://github.com/SuFIND/pi_local_remote_hub/security/advisories/new

(For an issue that only affects the iPhone app, use
https://github.com/SuFIND/pi_local_remote_ios/security/advisories/new.)

Include the affected commit or version, reproduction steps, impact, and any
suggested mitigation. Remove tokens, pairing codes, prompts, and tool output
from reports unless they are required to reproduce the issue.

## Supported versions

Security fixes apply to the latest release (currently 0.1.x) and the latest
commit on `main`.

## Security model

See `docs/SECURITY.md` for pairing, token storage, local-network exposure,
payload limits, and protocol invariants.
