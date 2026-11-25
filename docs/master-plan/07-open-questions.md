# Open questions and operating assumptions

The product is the full module catalog. Start all streams together, planned for January 2027 subject to clearance, staffing and funds. Target a September Toronto launch with all three ML baselines and follow the selected schedule for wider availability. Validate the assumptions below with the people who own the relevant contract or operating decision. Record the result, date and release impact in the applicable plan or customer order form. [Parallel roadmap](03-roadmap.md)

## Phase 0 employment review

The founder works full-time building a government AI platform. Before reusing any code, designs, prompts or patterns, review the employment contract and the employer's IP, confidentiality, conflict-of-interest and outside-activity policies. Have an Ontario employment lawyer do a short review that includes any public-sector or ethics rules applicable to the actual role. File disclosures and obtain written clearance when required. Build only on personal time and equipment with separate accounts. Exclude government data and confidential information from development, evaluation and AI tools. Record the clearance, scope and provenance decisions, and hold activity that needs unresolved clearance. [Employment/IP controls](05-governance-security-compliance.md#phase-0-employment-conflict-and-ip)

## Decisions to close

| By | Owner | Working decision and evidence |
| --- | --- | --- |
| Jan | Founder and delivery lead | Approve shared interfaces for self-hosted LangGraph. Set acceptance checks for voice latency, handoff and graph restart. [Runtime comparison](01-architecture.md#bot-runtime-decision) |
| Jan | Founder and platform lead | Select Canada Central capacity, native model family and carrier. Verify quotas, GPU supply and budget. Decide which premium adapters have a buyer or a credible design partner, and what feature parity and estimated cost each requires. [Provider design](01-architecture.md#provider-abstraction) |
| Jan–Mar | Delivery lead and Ontario counsel | Review creditor-operated collections, debtor classes, and exact email, AI voice and SMS scripts and provider routes. Confirm CASL, UTR/DNCL and ADAD coverage, CDSSA, recording, privacy, insurance and consent obligations. Assign responsibility for CRTC docket monitoring. |
| Before outbound live pilot | Ontario counsel, delivery lead and tenant approver | Recheck CRTC 2026-132 and sign off each channel and route. Verify tenant consent, pause controls, caller identity, safe greetings and texts, contact limits and supervised pilot evidence before widening. [Outbound gate](05-governance-security-compliance.md#outbound-voice-and-sms-collections-gate) |
| Feb–Apr | ERP lead and tenant accountant | Confirm native ERP scope, starting balances, inventory valuation/export expectations, ledger handoff and corrected record history. Use a signed export sample and verify access to CRA records. |
| Mar–Jun | Founder and partner lead | Test the GTA distributor segment, recurring price, migration fees and staffing assumptions with paid design partners. Quote CAD, separate setup/scope, and name the customer's approver and operations owner. |
| Mar–Aug | ML lead and tenant data owner | Confirm data rights and representative labels, holdouts, validation thresholds, target models, retention and deletion per tenant. Launch with rules, statistical baselines and grounded profiling. Compare tenant training candidates against the stated data floors and release criteria. [Data and ML plan](04-data-ml-plan.md) |
| Jun–Aug | Platform lead and assessor | Verify a second operator can restore a tenant and stop affected actions. Quote the SOC 2 scope, observation period and cost and record evidence collection ownership. [Assurance](05-governance-security-compliance.md#contracts-and-assurance) |
| Aug | Implementation lead and counsel | Verify which tenant and provider routes meet Ontario launch criteria, including support access, capacity, retention, opt-in fallback, reconciliation and invoice math. Document exceptions by capability and remediation owner. |
| Dec | Founder and counsel | Confirm US expansion readiness, select the first US state and scope buyer, provider and jurisdiction requirements. Keep Quebec's separate Law 25 assessment and provincial obligations on their own decision record before any rollout. [Geographic expansion](05-governance-security-compliance.md#geographic-expansion) |

## Assumptions to validate

| Assumption | Test or decision |
| --- | --- |
| Parallel staffing covers the calendar | The recommended schedule needs the lead hire in January, three contractors and implementation support from October. Founder works 15–25 hours/week outside the day job. Check lead and backup coverage before launch and track the funded labour and non-labour runway monthly. |
| Reference onboarding is repeatable | Plan for one operating entity and a standard distributor template, three paid Ontario design partners and four payers by December in the recommended plan, or eight in the September full-catalog plan. Compare setup time, cleanup and reconciliation across accounts. Keep tailored migration in a separate quote. |
| Customers value multiple modules | Track paid module choices, renewals, verified customer-service outcomes, approved PO accuracy, AR time, workflow self-service and model utility. Compare qualified referrals with direct outreach. Initial design partners provide directional evidence. |
| Tenant data may eventually support trained products | Measure mature fraud label volume, representative forecast history and reviewed profiling examples during intake. Exercise training paths with suitable licensed or synthetic data and require representative evidence for tenant activation. |
| Native and premium choices have clear economics | Set a token allowance and support ceiling in quotes. Confirm provider pricing, terms and charge mode before enabling a binding. Track setup coverage, support p50/p90, gross contribution and cash for each tenant against the CAD model. [Pricing and cash budget](06-pricing-packaging.md) |

## Risk register

| Risk | Mitigation and response | Accountable role |
| --- | --- | --- |
| Day-job conflict, IP claim or misuse of confidential material | Complete the Phase 0 contract, policy and employment-lawyer review. Keep separate personal resources and an asset provenance record. Obtain written clearance as required and hold any unresolved activity. | Founder |
| Shared interface drift or founder bottleneck | Give the daytime lead authority over routine decisions, incidents and recovery. Reserve founder evening review slots for material design, spend, commercial and launch decisions. Maintain backup coverage and move dates when staffing or reviews slip. | Founder and delivery lead |
| Incorrect disclosure, outreach or purchase | Verify identity, tenant and record permissions, material inputs, recipient and jurisdiction. Recheck approvals and dedupe effects. Pause affected capability and initiate incident response on material failure. | Security owner and customer approver |
| Automated outreach breach or CRTC rule change | Keep the outbound channel off pending written signoff. Recheck the docket and pause affected routes on rule change, opt-out failure, identity error or material complaint. Validate stop controls and use approved creditor staff handoff. | Communications lead, security owner and counsel |
| Native capacity or premium route failure | Test capacity, residency and parity early. Reconcile unknown writes, allow only approved fallbacks and have a human handoff. Open provider approvals in January. | Provider lead |
| ERP scope creep or data conversion error | One operational template, documented source ownership and reconciliation, scoped change orders and staged import/restore. Maintain a clear boundary with the authoritative ledger. | ERP lead and accountant |
| Biased or sparse model data | Review representativeness and loss/cost trade-offs, capture mature outcomes, evaluate with human review and roll back to the native baseline if needed. | ML lead and tenant data owner |
| Usage and assurance costs exceed cash plan | Set tenant and provider caps, reconcile monthly, get written audit and insurance quotes, and allocate contingency for measured variances. Track total cash and staffing runway against receipts and committed funds. | Founder and finance operations |
| Unexpected licence or processing terms | Inventory pinned components, datasets and weights, review model and connector terms and platform/tenant responsibilities, and update the affected route or deployment with evidence. | Platform lead and counsel |

[Overview](00-overview.md) · [Architecture](01-architecture.md) · [Modules](02-modules.md) · [Roadmap](03-roadmap.md) · [Data and ML](04-data-ml-plan.md) · [Governance](05-governance-security-compliance.md) · [Pricing](06-pricing-packaging.md)
