# Lane B fixture demo

Run the fixture API and portal in separate terminals from the repository root.

```sh
node apps/api/src/automation/demo.ts
pnpm --filter @bs/web dev --config src/vite.demo.ts --configLoader runner
```

Open the local Vite address. Use the Service desk to look up `ord-001`, ask for it
in chat, or run the voice fixture. Playback uses an installed local English
voice. The transcript and reply remain visible if none is available.

From Drafts & previews, draft `pr-001` and preview `inv-001` in each channel.
Request approval and use the Approval inbox to approve as the fixture
`actor-approver`. Workflows previews the `win-back-v1` audience and shows its
run history when requested and approved.

All delivery is simulated by default. For the separate local Mailpit smoke,
start the fixture Compose project, set `BS_MAILPIT=1` in the API terminal and
restart the fixture API. The defaults are `BS_MAILPIT_HOST=127.0.0.1` and
`BS_MAILPIT_PORT=1025`. Approve the email draft and check the Mailpit inbox at
port 8025. The adapter accepts loopback addresses and fictional recipients.

The fixture API binds to loopback and resolves the two demo actors by endpoint.
For integration, register `registerAutomation` under `/automation` with the
governed gateway, a verified identity resolver, and an approval signer.
Restarting the demo resets its gateway, checkpoints, inbox and run history.
