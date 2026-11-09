# RedNote Steward

Local Xiaohongshu publishing and account operations. Public code lives here; user configuration, media, browser sessions, databases and receipts live outside this repository.

- Keep CLI and MCP on the same controller and database.
- Bind account IDs to browser profiles. Serialize account writes and reconcile unknown outcomes before retrying.
- Preserve native topics and verify the same platform note after writes. Report submission, field readback and public visibility separately.
- Use synthetic fixtures. Never copy real account state or credentials into examples, tests or releases.
- Keep user-facing prose concrete, affirmative and concise. English README and Chinese README describe the same capabilities.
- Run `npm test` and `npm run check:package` before publication. Live account reads are separate evidence from mocked publishing tests.
