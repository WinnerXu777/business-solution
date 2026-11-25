# Safety notes

## Keep the day job separate

Use personal time, repositories, cloud accounts and AI accounts. Use personal equipment for development and the demo. Keep employer code, prompts, diagrams, tickets, data, credentials, recordings and internal design material out of the project and out of Codex and Claude sessions. Build from public documentation and original work. Check the employer's outside-work and IP terms where this project and the government AI role overlap.

## School GPU use

Check the school's acceptable-use policy on personal or non-academic projects and commercial use before running workloads. Use only fictional or licence-reviewed public datasets on school machines. Keep project code and artifacts in personal accounts and keep school, employer and personal IP separate.

## Keep the demo in test mode

- Use fictional business data, generated audio or owner-recorded test phrases, and licence-reviewed public ML datasets. Keep real customer records, personal identifiers, payment card data and employer material out of fixtures, uploads, prompts, backups and training. Record dataset and model licences before use.
- Use test-mode or sandbox keys only. Where a provider has no suitable test mode, use a fake adapter. Store keys outside Git and agent briefs. Keep provider access disabled by default and block live delivery from CI and the demo. Use Mailpit for email, browser audio for voice and simulated carrier receipts for outbound calls and SMS.
- Keep the Canadian deployment private. Check adapter egress separately from cloud location. Log IDs, decisions and usage with sensitive payloads redacted. Test that one workspace cannot read another workspace's records, model context or artifacts.

## Gate any future real outreach

- Before enabling real email or SMS, classify the message purpose and check CASL requirements for that use. For commercial electronic messages, keep evidence of applicable consent, identify the sender and provide a working unsubscribe mechanism, subject to the applicable rules. Apply current suppression at dispatch. [CRTC CASL guidance](https://crtc.gc.ca/eng/com500/faq500.htm)
- Before enabling calls, check the CRTC Unsolicited Telecommunications Rules for the call type, including National Do Not Call List and internal list obligations, permitted hours, caller identification and automatic dialing-announcing device rules. Obtain prior express consent where required for automated solicitation. For collections, also check the applicable Ontario rules and who is legally acting as collector. [CRTC calling rules](https://crtc.gc.ca/eng/phone/telemarketing/tobligations/rules-regles.htm) · [Ontario collections law](https://www.ontario.ca/laws/statute/90c14)
- At dispatch, recheck the exact approved action, recipient, current balance for collections, contact window, consent and cross-channel cadence. Verify the recipient before sharing debt details. Route disputes and negotiations to a person. Make pause and stop controls cover queued sends and active voice sessions.

## Cap provider spend

Start with paid routes disabled and use fixtures or open-source tools. For an allowed test route, set provider account limits where available and enforce separate application caps for tokens, audio seconds, messages, concurrent jobs and retries. Reserve units before dispatch and stop when the cap is exhausted or metering is unavailable. Alert before the cap, check usage after each test session, and leave fallback to paid routes opt-in. Apply the same checks to native and BYO bindings. Shut down idle compute and check whether stopped instances, snapshots or addresses still incur charges.

See the [overview](README.md), [architecture](architecture.md), [roadmap](roadmap.md), [module scopes](modules.md) and [agent workflow](dev-workflow.md).

Related research covers [voice and telephony](../master-plan/providers/voice-telephony.md), [LLM provider routing](../master-plan/providers/llm-models.md), [ML data handling](../master-plan/04-data-ml-plan.md) and the [SMB ERP CRM AI bot bundle](../../reports/SMB%20ERP%20CRM%20AI%20bot%20bundle.md).
