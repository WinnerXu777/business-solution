# Personal project plan

Build a small operations platform for a fictional Toronto-area wholesale distributor. It combines an ERP and CRM with AI assistants that can look up records, draft work and ask for approval before acting. The same permissions, approvals, policies and audit history apply whether a request comes from a person, a bot, the REST API, an MCP client or a saved workflow.

The owner builds it in Toronto on evenings and weekends, about 15–25 hours a week, alongside a full-time job building a government AI platform. Use personal equipment, accounts and time. Build locally first, then run one private Canadian cloud demo with fictional business records and test-mode integrations. [Project boundaries](safety-notes.md)

## What done looks like

- Load a repeatable distributor demo with companies, contacts, deals, orders, stock, suppliers and fictional balances. Look up an order from chat, browser voice, REST and Model Context Protocol (MCP). Show the system rejecting an unauthorized request.
- Turn a purchase requisition (PR) into a purchase order (PO) after approval. Review a collections email in a test inbox and demonstrate outbound voice and SMS with simulated delivery. Build, preview and run a win-back email workflow from the visual editor.
- Show a fraud review queue with both rules and a trained model, sales and demand forecasts with backtest results, and customer profiling with a fine-tuned language model compared with a prompted baseline.
- Call the native language model API and show how a compatible bring-your-own provider can be selected. Toggle module access and see usage counted once across retries. Rebuild the demo from a clean setup and restore it from a backup.

## How the work gets done

Set the shared interfaces and demo acceptance checks first. Give several Codex sessions separate, narrowly scoped tasks with their own branches and worktrees. Use the available Codex quota for independent work and bring in Claude to review integration candidates. The owner makes product and design decisions, reviews risky changes, integrates the branches and runs each milestone demo. Plan around the owner’s review time and carry unfinished work into another milestone when needed. [Roadmap](roadmap.md) · [Agent workflow](dev-workflow.md)

Read the [architecture](architecture.md) for stack choices and the [module scopes](modules.md) for what each feature does and what data it uses.

## Research references

- [Master architecture](../master-plan/01-architecture.md), [product modules](../master-plan/02-modules.md), [data and ML plan](../master-plan/04-data-ml-plan.md) and [SMB ERP CRM AI bot bundle](../../reports/SMB%20ERP%20CRM%20AI%20bot%20bundle.md).
- [Business systems](../master-plan/providers/business-systems.md), [LLM models](../master-plan/providers/llm-models.md), [ML and data](../master-plan/providers/ml-data.md), [platform infrastructure](../master-plan/providers/platform-infra.md) and [voice and telephony](../master-plan/providers/voice-telephony.md).
