# Security policy

Pi Remote for iOS can submit prompts to an active Pi session. Treat access as
equivalent to terminal access under the account running Pi.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting page:

https://github.com/tornikegomareli/pi-remote-ios/security/advisories/new

Include the affected commit or version, reproduction steps, impact, and any
suggested mitigation. Remove tokens, pairing codes, prompts, and tool output
from reports unless they are required to reproduce the issue.

## Supported versions

Until the first tagged release, security fixes apply only to the latest commit
on `main`. After releases begin, this file will list supported versions.

## Security model

See `docs/SECURITY.md` for pairing, token storage, tunnel exposure, payload
limits, and protocol invariants.
