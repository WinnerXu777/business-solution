# Parallel delivery roadmap

January–December 2027 is the planning calendar. All workstreams start together in January if Phase 0, funding and staffing are ready. The monthly tables show the five-contractor schedule, which targets the wider Toronto catalog in September. The recommended three-contractor schedule keeps the September Toronto core release and stages the wider catalog through March 2028. Both schedules ship the three ML baselines in September. Trained ML and outbound collections voice and SMS have their own activation gates. [Recommended schedule and dates](#lower-cost-parallel-plan)

## Phase 0 before the January start

Close the [employment and IP review](05-governance-security-compliance.md#phase-0-employment-conflict-and-ip), obtain any required written clearance, and establish personal equipment and independent accounts. Confirm the funded runway, named stream owners and lead start date before committing to paid delivery. If clearance, capital or coverage is late, move the staffed start and linked release dates together. January assumes financing discussions and lead recruiting are already in progress. If a raise starts in January and closes in April–June, a comparable staffing and testing sequence moves the Toronto release to December 2027–February 2028. Update staffing, baseline launch and cash dates together at close. [Funding plan](06-pricing-packaging.md#funding-plan)

## Staffing and operating rhythm

| Role and timing | Work and coverage in the September full-catalog plan |
| --- | --- |
| Technical founder, Jan–Dec | Works full-time building a government AI platform. Budget 20 hours/week outside the day job, with a 15–25 hour range. Reserve about 5 hours for shared design and integration decisions, 6 for buyer and investor work, 4 for demos and readiness reviews, and 5 for finance, staffing and decision buffer. |
| ERP and app contractors, Jan–Dec | At 128 hours/month each through September and 32 thereafter. One owns ERP/procurement. The other owns CRM, email collections, workflow UI and subscriptions. Coordinate the shared collections UI and guards with the communications contractor. Reserve named time for onboarding and review in June–August. |
| Communications and ML contractors, Jan–Nov | At 112 and 128 hours/month respectively. Communications owns chat, inbound voice, outbound collections channels and provider integration. ML owns data, fraud, forecasts, profiling and serving. Handover before December is a release dependency. |
| Platform/security contractor, Jan–Dec | At 80 hours/month through June and 24 thereafter. Acts as interim daytime delivery lead Jan–Mar, owns provisioning, gateway/REST/MCP fixtures and governance policies, and coordinates integration. Trains the lead engineer and serves as a named backup after handover. |
| Lead platform/product engineer, full-time from Apr | Takes daytime delivery leadership, owns API/MCP, gateway, Temporal and billing execution. Runs integration, staffing dependencies, operational readiness and incidents. Owns independent review assignments and the backup coverage roster. |
| Implementation/customer ops hire, Jun–Dec | Half-time June–August and full-time from September. Runs partner onboarding, setup, support and data intake. Before the hire starts, stream leads run daytime demos and data mapping under the delivery lead, with founder handling material commercial decisions. |
| Codex and AI-assisted development, Jan–Dec | Use AI for contracts, fixtures, adapter drafts, test cases, migrations and runbooks. Use synthetic or approved de-identified inputs. Named human owners review, test and own production work. |

The daytime delivery lead owns assignments, routine technical decisions, integrations, customer escalations and incident command. Name the ERP contractor as early operational backup until the lead hire takes over and the security contractor moves to backup. Confirm primary and backup coverage for each live service window. Keep live outbound contacts within staffed windows. Agree support hours in the order form and exercise pause, restore and escalation before a tenant goes live.

Use one shared staging tenant and a weekly daytime integration session with recorded demos and decision notes. The founder remains on the critical path for January shared contracts and high-impact architecture decisions, hiring and spend commitments, partner contract and product scope decisions, August commercial go/no-go and any later channel expansion. The delivery lead brings a recommendation and approval evidence to two evening review slots each week. Allow up to three business days for founder decisions. Escalate material changes there and use documented defaults for reversible decisions. Incident shutdown and recovery are delegated to the daytime lead and backup. Ontario counsel and the security owner sign the relevant release evidence.

Recheck staff coverage, cash and unresolved dependencies monthly. Keep July and August for onboarding, defects and acceptance. If the April lead hire slips, fund an interim daytime lead extension from confirmed cash or move rehearsal and launch. Shift dates or delay just the affected release if the communications or ML specialist is over capacity. Maintain work on every stream against common fixtures. Plan no founder implementation or on-call dependency. [Staffing costs and cash burn](06-pricing-packaging.md#first-12-month-cash-budget)

**Founder transition.** Keep the 15–25 hour schedule until there is written clearance as applicable, an agreed household income floor and either (1) cash in the bank for 12 months of the forward operating plan including founder pay, or (2) six consecutive months of recurring cash contribution after direct delivery costs covering fixed operating costs and that pay, with six months of cash reserves. Use $120K annual base plus 20% payroll and benefits as the initial transition assumption, then confirm against household needs. The 2027 model assumes no transition. [Funding plan](06-pricing-packaging.md#funding-plan)

## Contracts to agree in January

| Contract | Owners and consumers | Agree before building against it |
| --- | --- | --- |
| Identity and tool envelope | Platform, governance, REST/MCP, bots, builder and adapters | Tenant/actor/trace identifiers, grants, typed inputs/results, error classes, action risk, source freshness, approval/expiry and idempotency. Publish contract fixtures and policy denial cases. |
| Business records and events | ERP, CRM, connectors, niche bots, channels and data/ML | Authoritative systems by record class, stable IDs, mapping and version, money, timestamps, order/PO lifecycle, balance and payment freshness, inventory corrections and consent/suppression. Agree schema evolution and reconciliation. |
| Runtime and workflow | Delivery lead, chat, voice, niche bots and builder | Run/stream/interrupt/resume, state scope, version pinning, event and checkpoint references, replay semantics, call deadlines and handoff. Typed node inputs and approved action set. |
| Provider and cost | Providers, platform, governance, all modules and subscriptions | Binding and credential ownership, capability flags, format parity, data locations and retention, fallback, signed webhooks, rates, raw meter units, logical outcome IDs and native/BYOK/pass-through charge modes. |
| Data and models | Data/ML, ERP, CRM, integrations, fraud, forecasting and profiling | Purpose and training rights, dataset/feature/label provenance, prediction input/output, model provenance, evaluation metrics, abstention/fallback, overrides, artifact deletion and monitoring. |
| Customer acceptance | GTM, implementation, security, finance and module owners | Setup scope, sandbox fixtures, baseline metrics, accountable customer roles, approvals, provider disclosures, launch checks, support limits, incident response and export format. |

## January–June

| Workstream and lead | Jan | Feb | Mar | Apr | May | Jun |
| --- | --- | --- | --- | --- | --- | --- |
| Platform and infrastructure · platform contractor, then hire | Region, tenancy and deployment contracts | Terraform, CI and regional staging | Tenant provisioning, queue and logs | Temporal and operational dashboards | Backups and tenant restore | Run failover and load drills |
| Governance and security · platform contractor, then lead hire | Tool scopes, risk rules and counsel brief | Identity, policy and approvals | Audit/outbox and revocation | External-effect reconciliation | Isolation and incident exercises | Sign control inventory and rehearse response |
| Native REST/API and MCP · platform contractor, then lead hire | REST/MCP scopes and schemas | Generated types and mock endpoints | Shared read tools and MCP auth | Governed write tools | Partner-client interoperability | Validate denial, replay and revocation parity |
| Native ERP · ERP contractor | Record ownership and accountant brief | Sales orders and stock ledger | Purchasing, fulfilment and receipts | Ledger export and reconciliation | Import and restore on realistic data | Customer accountant walkthrough |
| Native CRM · app contractor | Contact, deal and consent schema | Companies, contacts and deals | Activity and permissions | Dedupe, consent and suppression | Import, export and access requests | Test linked sales, service and campaigns |
| Chat bot · communications contractor | Session and handoff contract | Native widget and knowledge | Verified order lookup | Draft quote and queue | Accessibility and unsafe-input tests | Service team acceptance |
| Inbound voice bot · communications contractor | Voice edge, SIP and LangGraph contract | Streaming speech and greeting | Verified order status and fallback | Handoff, interruption and latency | Native/premium route swap | Supervised calls and disruption drills |
| PR-to-PO bot · ERP contractor | Requisition, budget and authority | Draft generation and supplier checks | Approval and ERP write fixtures | Native purchase flow and retries | Exception and alternate ERP tests | Purchasing staff rehearsal |
| Collections email bot · app contractor | Ontario scope and send fixtures | Drafts, holds and approval UI | Live-balance and suppression checks | Verified sender and reply routing | Ambiguous outcome and payment tests | Counsel and AR staff acceptance |
| Collections outbound AI voice and SMS · communications contractor and app contractor | Counsel brief and channel policy | Consent, reply and status fixtures | Sandbox scripts, local time and shared contact counts | Wire carrier and sender routes | Test opt-outs, verification and kill switches | Simulate end-to-end contacts and confirm provider terms |
| Customer workflow builder · app contractor and platform hire | Definition and trigger contract | Visual editor and dry-run | Native trigger and action execution | Timers, branches and approvals | Version, pause and win-back | Admin self-service rehearsal |
| Fraud review · ML contractor | Features, label and review capacity | Rule baseline and labeling UI | Point-in-time training data | Fit and calibrate candidate with licensed or synthetic fixtures | Evaluate and shadow where real data permits | Reviewer feedback and threshold checks |
| Sales/demand prediction · ML contractor | History intake and target horizon | Time series and quality checks | Baseline backtests | Fit trained models and ranges | Rolling holdouts and planner UI | Live shadow forecasts and exports |
| Customer profiling and fine-tuning · ML contractor | Taxonomy, rights and evaluation | Reviewed examples and retrieval | Prompting baseline and registry | Fine-tune candidate and compare | Leakage and removal tests | Shadow QA and staff review |
| Modular subscriptions · app contractor | SKUs, allowances and unit schema | Entitlements and quote fixtures | Usage ledger and native cost meters | Recurring billing and portal | BYOK, uplift and credits | Shadow invoices across modules |
| Data and ML foundation · ML contractor | Dataset contract and rights ledger | Ingest, label access and snapshots | Regional model API and register artifacts | Tenant training jobs and replay | Deletion and rollback exercise | Reproducibility and data-quality review |
| Provider integrations · communications contractor | Capability map, applications and region review | Native adapters and connector fixtures | Carrier, mail and incumbent ledger wiring | Premium speech, contact centre and LLM routes | Adapter parity, billing and fallbacks | Verify vendor terms, data flows and cutover |
| Go-to-market · founder on sales, lead and implementation hire on delivery | Toronto interviews and partner outreach | Paid package and onboarding materials | Recruit design partners and agree outcomes | Draft contracts and map data | Demonstrate workflows to partners | Sign paid partners and start onboarding |

## July–December

| Workstream | Jul | Aug | Sep | Oct | Nov | Dec |
| --- | --- | --- | --- | --- | --- | --- |
| Platform and infrastructure | Production-like scale rehearsal | Disaster drill and capacity signoff | Operate Ontario launch | Tune cost and response time | Recovery handover and regression | US deployment template and quote |
| Governance and security | Independent security test | Fix findings and sign Ontario release criteria | Monitor live effects and collect evidence | Access review and restore evidence | Auditor sampling and vendor review | Type II evidence handoff as scheduled |
| Native REST/API and MCP | Tenant sandbox with integrators | OpenAPI/SDK docs and auth signoff | Publish supported tools | Measure adoption and denial rates | Verify compatibility and upgrade tooling | Review US connector differences |
| Native ERP | Onboard reference data, reconcile opening stock | Cutover and accountant acceptance | Launch operational ERP | Repeat onboarding and measure effort | Improve inventory exceptions | Test staged upgrade and export |
| Native CRM | Migrate reference data | Role, consent and export acceptance | Launch native CRM | Measure import and adoption | Improve field mapping | Verify portability and privacy requests |
| Chat bot | Monitor inbox and failure cases | Tune verified response and handoff | Launch chat | Review answer quality | Expand common knowledge patterns | Retest channel boundary cases |
| Inbound voice bot | Test carrier failover and routing | Tune quality for diverse callers | Launch native voice and approved swaps | Review cost, latency and escalations | Tune queue and speech settings | Regression-test provider changes |
| PR-to-PO bot | Run supervised requisitions | Reconcile duplicates, exceptions and receipts | Launch procurement | Measure draft time and correction rate | Add repeatable exception mappings | Review purchasing limits |
| Collections email bot | Run approved tenant email sends | Reconcile stops, replies and holds | Launch Ontario collections email | Review staff time, outcomes and complaints | Repeat debtor eligibility sampling | Prepare first US state legal analysis |
| Collections outbound AI voice and SMS | Sandbox controls and counsel review | Recheck CRTC docket, sign scripts and rehearse stop | Activate by approved tenant and channel only after the gate | Supervise contacts and review complaints | Expand cleared routes after review | Rerun policy and pause drills |
| Customer workflow builder | Admins publish reviewed workflows | Verify consent and revocation end to end | Launch editor and templates | Measure admin independence | Broaden approved node library | Version upgrade and replay drill |
| Fraud review | Tune rules and validate reason codes | Sign baseline and shadow criteria | Launch rules-based review and gate trained scoring per tenant | Monitor false positives and drift | Recalibrate on mature outcomes | Review reviewer value and model cost |
| Sales/demand prediction | Compare with planner decisions | Validate coverage and uncertainty | Launch statistical forecasts and gate trained models per tenant | Check accuracy and overrides | Refresh fit and compare cohorts | Review inventory planning usefulness |
| Customer profiling and fine-tuning | Review grounded profiles and compare candidates | Check registry and deletion in staging | Launch retrieval and structured prompting | Measure corrections and abstentions | Activate qualifying tenant fine-tunes after shadow review | Recheck holdout, cost and portability |
| Modular subscriptions | Customer invoice reconciliation | Test renewals, caps and upgrades | Launch recurring subscriptions | Audit first live invoices | Adjust unit assumptions using actual bills | Review margins and tax setup |
| Data and ML foundation | Run drift and rollback drills | Validate registry and provider provenance | Operate monitored regional inference and training | Review dataset quality and expiry | Validate deletion across artifacts and providers | Reassess GPU sizing and model licences |
| Provider integrations | Exercise native/premium swaps with partners | Support and quota signoff | Launch verified catalog | Review cost, incidents and residency | Qualify additional provider adapters | Compare regions and US vendor terms |
| Go-to-market | Run paid early deployments | Finish setup packages and partner enablement | Toronto commercial launch | Referral-led onboarding | Renewals and adjacent Ontario discovery | US readiness decision and Quebec review status |

## Shared integration milestones

| When | What meets | Evidence to accept |
| --- | --- | --- |
| End Jan | All streams exchange contract v1 and mock data | Contract owners agree test fixtures, staffing coverage and the LangGraph interface. Submit vendor applications and legal briefs concurrently. |
| End Mar | First shared staging tenant | Chat, voice and MCP read the same order. CRM publishes a consent event. Procurement, collections and the builder use one approval path. ML consumes common source events. Usage captures logical and provider units. |
| End Jun | All-module rehearsal | Show native end-to-end journeys, eligible provider swaps, model shadow outputs, billable and nonbillable replays, a side-effect-free workflow preview and a tenant restore. Rehearse outbound voice and SMS on fixtures. Book auditor scope and independent security review. |
| Jul–Aug | Paid early deployments and Ontario release checks | Design partners use the catalog under supervised onboarding. Verify record-level isolation, safety, replay, accounting and export, approved provider geography, signed scopes and metering. Assess models against [their individual criteria](04-data-ml-plan.md#shared-release-process). |
| Sep | Toronto commercial launch | Release the wider sellable Ontario catalog and the three ML baselines. Enable live outbound voice/SMS only with written legal, security, provider and tenant signoff. Trained ML needs separate evidence per tenant. [Outbound gate](05-governance-security-compliance.md#outbound-voice-and-sms-collections-gate) · [ML thresholds](04-data-ml-plan.md#minimum-evidence-for-trained-tenant-releases) |
| Dec | Repeatability and US expansion decision | Review live availability, paid adoption, support hours, gross margins and renewals. Choose a candidate US state and scope regional configuration with counsel and a local partner. Base any expansion approval on Ontario delivery evidence. Track Quebec Law 25 work separately. |

## Lower-cost parallel plan

Use three contractors and hire the delivery lead full-time in January. The app contractor works both ERP/procurement and CRM/workflow lanes every cycle. The lead hire owns platform, governance, API/MCP, workflow execution and billing. The communications contractor works on inbound service, integrations and outbound channels every cycle. The ML contractor builds all three baselines and trained paths. Assign the app contractor as trained operational backup and pay for independent security testing. Implementation starts half-time in October and moves to full-time in December. Until then the lead coordinates onboarding, with contractors handling mapping and acceptance within their budgeted hours and the founder closing commercial decisions.

Use Codex more heavily for scaffolding, tests, migrations and integration fixtures. Price the schedule on the reduced paid hours and calendar extensions. Use one distributor template and a common native configuration to reduce early integration and onboarding load. Keep native and premium provider work active in staging. Track each stream in the same weekly integration review.

| Target | Release and evidence |
| --- | --- |
| Jan–Apr 2027 | Start every stream with named owners and fixtures in January. Integrate the first shared tenant by April. |
| May–Aug 2027 | Rehearse all streams in staging by July. Complete independent tests and fixes before live partner use. Sign three design partners in August and stagger setup and data acceptance within the cohort. |
| Sep 2027 | Start paid Toronto core release with the reference ERP/CRM, governance, initial REST/MCP surface, chat, approved email collections and billing. Release rules-based fraud, statistical forecasts and grounded profiles on usable feeds. Give the three partners named onboarding and support windows. |
| Oct–Dec 2027 | Extend rollout to inbound voice, PR-to-PO, workflow editor/templates and validated provider routes, targeting standard tenant onboarding in December. Exercise outbound voice/SMS with sandbox controls and seek counsel and provider review. |
| Jan–Mar 2028 | Target wider catalog availability including additional verified provider paths and expanded workflow, API and MCP coverage. Target gated outbound voice/SMS activation in this window, subject to signoff even if it moves later. Tenant-specific ML activation follows the evidence as it arrives. |

Validate throughput and the lead's coverage after two integration cycles. If onboarding, response coverage or release testing misses its checkpoint, move the affected launch dates and reforecast 2028 cash. Apply the same release standards in both plans. [Lower-cost cash and revenue assumptions](06-pricing-packaging.md#revenue-and-monthly-burn)

Agree customer baselines before deployment. Track verified chat/voice resolution, corrective edits, AR minutes per eligible account, approved procurement accuracy, self-service workflow publish, model utility and direct cost per tenant. Three payments or renewals can test delivery and willingness to pay. Track repeat outcomes before using them to predict retention. [Market assumptions and risks](07-open-questions.md)

[Overview](00-overview.md) · [Architecture](01-architecture.md) · [Modules](02-modules.md) · [Pricing and budget](06-pricing-packaging.md)
