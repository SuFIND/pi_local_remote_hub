Explain what changed, why it changed, and any security or protocol impact.

Checks:

- [ ] `npm run check`
- [ ] `swift test --package-path mac/PiHub` (when `mac/` changes)
- [ ] Protocol changes update TypeScript, the Swift types in pi_local_remote_ios, documentation, and tests
- [ ] No tokens, pairing codes, prompts, or tool output appear in logs or fixtures
