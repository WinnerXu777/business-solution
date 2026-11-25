# Runnable examples

From the repository root, run the offline example with Node.js 24. It exercises governed REST, MCP, audit pagination, LLM streaming and webhook verification with synthetic data and an injected fake fetch.

```sh
node docs/developer/examples/offline.mjs
```

The second example uses the local `pnpm dev` fixture host. Pass a fixture bearer through `BS_TOKEN`. The example reads the same fictional order through REST and MCP.

```powershell
$env:BS_TOKEN = 'fixture-reader'
node docs/developer/examples/local-order.mjs
```
