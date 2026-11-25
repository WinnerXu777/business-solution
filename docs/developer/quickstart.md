# Quickstart

Start the local fixture host with `pnpm dev` from the repository root if you want to run against an API. The default CLI address is `http://127.0.0.1:3000`. For an offline walkthrough with a fake transport, run `node docs/developer/examples/offline.mjs`.

Use the CLI directly from the checkout. These commands use PowerShell and the fixture reader identity.

```powershell
$env:BS_TOKEN = 'fixture-reader'
node packages/sdk/bin/bs.ts login --bearer-env BS_TOKEN --profile rq-reader --tenant tenant-rivetquay
node packages/sdk/bin/bs.ts whoami
node packages/sdk/bin/bs.ts records get order ord-001 --json
node packages/sdk/bin/bs.ts records list order ord-001 ord-003
node packages/sdk/bin/bs.ts tools call order.read --input '{"orderId":"ord-001"}' --json
node packages/sdk/bin/bs.ts usage
node packages/sdk/bin/bs.ts billing summary
```

On Windows PowerShell 5.1, pass JSON to the Node executable with escaped embedded quotes if native argument handling removes them, or run the example in PowerShell 7. `records list` reads the given IDs in order using the governed lookup tools. A missing or inaccessible ID stops the batch. Available kinds are `order`, `customer`, `invoice`, and `purchase-request`. The fixture API exposes individual lookups.

For workflows and bots, select the fixture operator. The preview produces a plan; a run can pause for review.

```powershell
$env:BS_OPERATOR_TOKEN = 'fixture-operator'
node packages/sdk/bin/bs.ts login --bearer-env BS_OPERATOR_TOKEN --profile rq-operator
node packages/sdk/bin/bs.ts workflows list
node packages/sdk/bin/bs.ts workflows preview win-back-v1 --json
node packages/sdk/bin/bs.ts workflows run win-back-v1 --idempotency-key fixture-winback-001
node packages/sdk/bin/bs.ts bots run fixture-chat --prompt 'Find order ord-001' --route native --json
```

Use an approver profile to list approvals, sign a designated approval, or reject it with a reason. Use `approvals sign ID --workflow` when a runtime workflow is paused and should resume after signing. The standalone CLI examples use the platform host's fixture IDs. [Milestone walkthrough](../personal-plan/milestone-1.md)

```powershell
$env:BS_APPROVER_TOKEN = 'fixture-approver'
node packages/sdk/bin/bs.ts login --bearer-env BS_APPROVER_TOKEN --profile rq-approver
node packages/sdk/bin/bs.ts approvals list --state pending
node packages/sdk/bin/bs.ts config list
node packages/sdk/bin/bs.ts config use rq-operator
```

The connector plugin must be registered on your fixture host. `connectors list` shows the catalog. `connectors sync` takes the binding ID returned when that host installs a connector.

```powershell
node packages/sdk/bin/bs.ts connectors list --json
node packages/sdk/bin/bs.ts connectors sync fixture-binding-id --mode poll --max-pages 5 --json
```

Table output is the default. `--json` and `--output json` emit JSON. Bot runs emit one JSON object per line with `type: "run"` for the initial and final views and `type: "event"` for progress. Streamed LLM chat emits one chunk per line in JSON mode. Errors go to stderr and failures exit with status 1. Run `node packages/sdk/bin/bs.ts --help` for the command list.
