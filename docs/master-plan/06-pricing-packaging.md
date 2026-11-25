# Pricing and packaging

Quote CAD before applicable tax. Every tenant buys the Platform subscription and selects product modules. **Native service is included in the subscribed allowance.** Adjust proposed prices using Toronto customer quotes, actual support time and provider costs. All prices and allowances below are test assumptions.

## Subscription catalog

| Subscription or module | CAD/month | Example included allowance and billable outcome |
| --- | ---: | --- |
| Platform | $650 | One legal entity, 10 named staff, governance, approvals, audit/export, REST/MCP, one standard connection, and up to 2 hours/month of discretionary support. Includes 1 million processed tokens per month for direct calls to the standard native LLM API. |
| Native or connected ERP | $400 | One operational entity, two stock locations and 1,000 unique orders recorded. |
| Native or connected CRM | $250 | One CRM workspace and 10,000 active company/contact records, measured as a monthly peak. |
| Inbound chat | $200 | 500 handled conversations. Count each conversation once within its session window. |
| Inbound voice | $400 | 1,000 connected minutes. Aggregate seconds before conversion. |
| PR-to-PO | $300 | 100 unique approved requisitions converted to purchase drafts. |
| Collections email | $300 | 500 accepted B2B reminders. Drafts and retries carry no separate charge. |
| Collections outbound AI voice and SMS | $350 | Proposed add-on after Ontario channel approval. Test an allowance of 250 connected minutes and 500 accepted SMS segments. Carrier minimums and premium routes are quoted separately. |
| Customer workflow builder | $350 | 1,000 published production runs completing an eligible action. Previews and replays of the same outcome are included. |
| Fraud review | $500 | 5,000 unique orders scored by rules or trained models. Shadow evaluations are included. |
| Sales and demand prediction | $400 | 500 SKU/location series forecast weekly. |
| Customer profiling | $500 | 500 unique published account profiles. Includes native retrieval and inference. Data-qualified tenants can use one standard native fine-tuning run per quarter within the quoted compute allowance. Quote larger runs and premium training separately. |

An example Operations configuration combines Platform, ERP, CRM, chat, voice, procurement and collections at **$2,500/month**. The reference catalog is **$4,250/month** before the gated outbound add-on and **$4,600/month** with it. Customers can select any supported combination and use a compatible external system for a given record class. Publish the dependencies for each module before quoting. Offer standard onboarding at **$3,000–$5,000** and scoped ERP/CRM mapping, migration and training **$8,000–$15,000**, based on imports, reconciliation and acceptance work. Bundle setup activities if the scopes overlap. Quote entity, seats, locations, connections, change orders and support hours explicitly. Include platform incident response in the service terms.

Test with paid Toronto design partners buying selected modules from the catalog and reference onboarding. Track signed setup, subscription attachment and renewals. Review paid setups and quotes before standardizing packages. Compare referrals from local bookkeepers, CPAs and fractional CFOs with direct founder outreach. Test referral terms only after confirming cost and professional disclosure rules. [Business model research](../../research_notes/SMB%20ERP%20CRM%20AI%20bot%20bundle/business_model_gtm.md)

## Native and premium providers

- **Native included.** The module price covers the native capability up to its allowance, including native inference used by module actions. Direct LLM API usage counts processed input and output tokens at the gateway and has its own spend cap. Show combined bundle allowances and any shared limits in the order form.
- **Bring your own provider.** Customers can retain a supported contract or key and pay that vendor directly. Show its usage for visibility and quote any fixed integration or support uplift. The platform does not invoice the vendor's usage again.
- **Platform-managed premium.** Charge itemized pass-through at the agreed basis or a disclosed fixed/usage uplift. Quote licence minimums, reserved capacity, exchange-rate treatment, tax, included amounts and reconciliation. The platform bills the agreed premium route and continues to supply the subscribed modules. Disclose how provider meters and platform allowances interact before any change.
- **Mix by service.** A tenant can keep its RingCX account, use ElevenLabs speech and an approved customer-held model key, and subscribe to native CRM and forecasting. Present the projected cost and data locations for the specific provider bindings and any authorized fallback. [Provider architecture](01-architecture.md#provider-abstraction)

Provider selection and comparisons are in [voice and telephony](providers/voice-telephony.md), [LLM models](providers/llm-models.md), [business systems](providers/business-systems.md), [ML and data](providers/ml-data.md) and [platform infrastructure](providers/platform-infra.md).

## Metering and invoice controls

- Record each logical billable outcome once by tenant, SKU, outcome ID, unit, quantity and price version. Record provider attempts and raw units in a linked cost ledger. Reconcile carrier minutes, sends, model tokens, training jobs and invoices against upstream evidence. Keep BYOK costs informational and post corrections as auditable credits.
- Publish allowances, definitions, late-event handling and caps. Alert at 80% and 100%. Require opt-in for overages with a spend ceiling. At cap, hand off chat or calls and pause eligible noncritical jobs. Preserve approvals, audit and export access.
- Derive entitlements from the subscription ledger. Validate signed billing callbacks, handle out-of-order events and test replay. Shadow invoices before launch and review the first three charged billing cycles. Keep platform settlement accounts separate from customer merchant accounts. Show current usage, forecast and dispute references in the portal.

## Unit economics

| Case | Illustrative monthly direct costs | Contribution before acquisition and fixed overhead |
| --- | --- | --- |
| Operations at $2,500 | 8 staff hours at $75, $240 cloud/providers, $135 allocated assurance/delivery tools and $100 processing | $1,425, or 57%. At 15 staff hours with equal other costs the contribution is $900, or 36%. |
| Reference catalog before outbound add-on at $4,250 | 12 staff hours at $75, $650 cloud/providers, $180 allocated assurance/delivery tools and $170 processing | $2,350, or about 55%. |

Use a 50% recurring contribution target in the model. Price setup to cover its labour and direct costs. Document support p50/p90, price leakage and setup recovery by tenant. Check actual invoices, recurring provider spend and cash collected monthly. If a delivery pattern exceeds scope, improve tooling, staffing or the scoped quote. Track acquisition and discount payback separately.

## First 12-month cash budget

January–December 2027 in **CAD thousands**, before recoverable HST. This includes delivery labour, implementation, benefits, cloud, providers, assurance and contingency. Founder time is unpaid while employed and has $0 cash cost in both plans. Customer-paid premium usage stays off the company's books. Budgeted non-labour cash includes Phase 0 invoices paid in January, initial equipment, recruitment and AI tool seats. Dates, wages and rates are planning estimates. Confirm written quotes and payment terms before signing.

### Labour

Contractor figures are Toronto direct bill rates. Hours are billable hours per month. Employee figures use annual base pay plus 20% for employer payroll contributions and benefits, prorated by start date and hours. Toronto wage data and local contract postings inform the estimates. Specialist rates include a premium for fractional availability. [Toronto software engineer wages](https://www.jobbank.gc.ca/marketreport/wages-occupation/5485/geo9219) · [Toronto business systems posting](https://www.qc.jobbank.gc.ca/jobsearch/jobposting/50384718) · [Toronto platform contract posting](https://www.randstad.ca/jobs/platform-engineer_toronto_47489958/) · [Procom Toronto contract rate guide](https://procomservices.com/wp-content/uploads/2026/01/2026-Salary-Guide.pdf)

| Role | Rate or loaded annual salary | September full-catalog plan | Cash | Lower-cost plan | Cash |
| --- | --- | --- | ---: | --- | ---: |
| ERP and procurement contractor | $100/hour | 128 Jan–Sep, 32 Oct–Dec | 124.80 | Leads both app lanes, 112 Jan–Nov, 80 Dec | 131.20 |
| CRM, collections, workflow and billing contractor | $95/hour | 128 Jan–Sep, 32 Oct–Dec | 118.56 | App contractor and lead hire share this work | 0 |
| Communications and integrations contractor | $110/hour | 112 Jan–Nov | 135.52 | 80 Jan–Nov, 64 Dec | 103.84 |
| Applied ML contractor | $120/hour | 128 Jan–Nov | 168.96 | 80 Jan–Nov, 64 Dec | 113.28 |
| Platform and security contractor | $115/hour | 80 Jan–Jun, 24 Jul–Dec | 71.76 | Lead hire and assigned backup cover this work | 0 |
| Lead platform/product engineer | $150K + $30K = $180K | Full-time Apr–Dec | 135.00 | Full-time Jan–Dec | 180.00 |
| Implementation/customer ops hire | $90K + $18K = $108K | Half-time Jun–Aug, full-time Sep–Dec | 49.50 | Half-time Oct–Nov, full-time Dec | 18.00 |
| **Total labour** | | | **804.10** | | **546.32** |

### Non-labour cash

| Operating cash item | Jan–Mar | Apr–Jun | Jul–Sep | Oct–Dec | Full-catalog year |
| --- | ---: | ---: | ---: | ---: | ---: |
| Counsel, privacy, employment/IP, contracts, Ontario collections and initial US/Quebec scoping | 15 | 9 | 9 | 7 | 40 |
| Tech E&O, cyber and business insurance | 4 | 2 | 1 | 1 | 8 |
| SOC 2 readiness, evidence tooling and auditor payments | 3 | 7 | 9 | 11 | 30 |
| Independent security test and retest | 0 | 2 | 8 | 2 | 12 |
| Canadian cloud, database, backups, monitoring and capped GPU infrastructure | 4 | 6 | 9 | 11 | 30 |
| Provider accounts, integration and outbound carrier validation, and operating usage | 2 | 5 | 10 | 9 | 26 |
| Accounting, incorporation/admin and billing tools | 2 | 2 | 2 | 2 | 8 |
| Toronto discovery, partner enablement and launch | 2 | 3 | 5 | 5 | 15 |
| Equipment, recruitment and AI development seats | 2 | 2 | 4 | 2 | 10 |
| Contingency for usage, FX, security remediation and quote variation | 4 | 5 | 7 | 7 | 23 |
| **Total non-labour** | **38** | **43** | **64** | **57** | **202** |

The lower-cost plan carries the same provisions and shifts $3K of auditor payments into 2028. Its 2027 non-labour cash by quarter is $38K, $42K, $57K and $62K. Both plans start control evidence in January and fund independent testing before the first live release. Report delivery follows the auditor's observation schedule. [Assurance plan](05-governance-security-compliance.md#contracts-and-assurance)

### Revenue and monthly burn

Model three design partners at $4K setup each (half at signing and half at delivery) and $2K/month each for selected modules. In the full-catalog plan they sign in June and start subscriptions in July. Add five standard tenants at $4K setup plus $2.5K/month, with one joining in September, one in October, two in November and one in December. Expect $48K from partners and $50K from new tenants, including $32K of combined setup receipts, with **eight payers and $18.5K MRR in December**. The lower-cost plan moves partner signings and starts to August and September and adds one standard tenant in December. Expect $36K from partners and $6.5K from that tenant, including $16K of combined setup receipts, with **four payers and $8.5K MRR in December**. Assume payment in the month shown, no churn, and $0 from outbound voice/SMS, grants, overages and premium usage. Use payment dates to update the cash forecast.

**September full-catalog plan**

| Month | Labour | Non-labour | Gross burn | Partner cash | Other tenant cash | Net burn |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Jan | 61.84 | 15.00 | 76.84 | 0.00 | 0.00 | 76.84 |
| Feb | 61.84 | 11.00 | 72.84 | 0.00 | 0.00 | 72.84 |
| Mar | 61.84 | 12.00 | 73.84 | 0.00 | 0.00 | 73.84 |
| Apr | 76.84 | 13.00 | 89.84 | 0.00 | 0.00 | 89.84 |
| May | 76.84 | 14.00 | 90.84 | 0.00 | 0.00 | 90.84 |
| Jun | 81.34 | 16.00 | 97.34 | 6.00 | 0.00 | 91.34 |
| Jul | 74.90 | 20.00 | 94.90 | 12.00 | 0.00 | 82.90 |
| Aug | 74.90 | 23.00 | 97.90 | 6.00 | 0.00 | 91.90 |
| Sep | 79.40 | 21.00 | 100.40 | 6.00 | 6.50 | 87.90 |
| Oct | 60.68 | 18.00 | 78.68 | 6.00 | 9.00 | 63.68 |
| Nov | 60.68 | 18.00 | 78.68 | 6.00 | 18.00 | 54.68 |
| Dec | 33.00 | 21.00 | 54.00 | 6.00 | 16.50 | 31.50 |
| **Total** | **804.10** | **202.00** | **1,006.10** | **48.00** | **50.00** | **908.10** |

**Lower-cost plan**

| Month | Labour | Non-labour | Gross burn | Partner cash | Other tenant cash | Net burn |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Jan | 44.60 | 15.00 | 59.60 | 0.00 | 0.00 | 59.60 |
| Feb | 44.60 | 11.00 | 55.60 | 0.00 | 0.00 | 55.60 |
| Mar | 44.60 | 12.00 | 56.60 | 0.00 | 0.00 | 56.60 |
| Apr | 44.60 | 13.00 | 57.60 | 0.00 | 0.00 | 57.60 |
| May | 44.60 | 14.00 | 58.60 | 0.00 | 0.00 | 58.60 |
| Jun | 44.60 | 15.00 | 59.60 | 0.00 | 0.00 | 59.60 |
| Jul | 44.60 | 17.00 | 61.60 | 0.00 | 0.00 | 61.60 |
| Aug | 44.60 | 19.00 | 63.60 | 6.00 | 0.00 | 57.60 |
| Sep | 44.60 | 21.00 | 65.60 | 12.00 | 0.00 | 53.60 |
| Oct | 49.10 | 19.00 | 68.10 | 6.00 | 0.00 | 62.10 |
| Nov | 49.10 | 20.00 | 69.10 | 6.00 | 0.00 | 63.10 |
| Dec | 46.72 | 23.00 | 69.72 | 6.00 | 6.50 | 57.22 |
| **Total** | **546.32** | **199.00** | **745.32** | **36.00** | **6.50** | **702.82** |

Average gross and net monthly burn are $83.84K and $75.68K in the full-catalog plan and $62.11K and $58.57K in the lower-cost plan. If collections on every customer invoice slip one month, year-end cash needed rises to $930.60K and $715.32K. With zero customer cash, the gross totals apply. For the full-catalog plan secure **$1.05M**. For the lower-cost plan secure **$800K**, covering zero first-year receipts and leaving about $55K beyond budgeted spending. Track HST settlement timing, invoice delays and committed costs in the monthly cash forecast. Reserve a further $210K gross for January–March 2028 in the lower-cost plan as an initial estimate at $70K/month. Reforecast using actual support, receipts and contractor extensions by October. This is outside the 2027 cash target.

## Funding plan

Ranges below are CAD planning cases. Budget $0 from unapproved contributions, tax refunds and debt toward the 2027 staffing commitment. Keep a project-level ledger of wages, contracts and assistance so the accountant can reconcile eligibility, net eligible costs and stacking limits.

| Source | Amount and timing | How it fits |
| --- | --- | --- |
| After-tax salary savings | Assume $1K–$2.5K/month ($12K–$30K/year) once the founder confirms household headroom. Set aside an initial $3K–$5K for Phase 0 counsel and setup from available savings. | Pays for clearance, discovery and early planning. Record transfers as founder equity or shareholder loans with accountant advice. |
| Federal SR&ED | Illustrative $35K–$70K federal refund if the accountant verifies $100K–$200K of qualifying current expenditures, net of assistance and provincial credit interactions, and the company qualifies for the refundable 35% rate. File after the assumed December 2027 year-end, targeting Q1 2028. CRA service standards for refundable claims range from 60 to 180 days after a complete submission. Plan for Q2–Q4 2028 cash. | Document technological uncertainty, experiments, results and time contemporaneously. Screen out routine integration, delivery, sales and implementation. [CRA credit rates](https://www.canada.ca/en/revenue-agency/services/scientific-research-experimental-development-tax-incentive-program/sred-claim/investment-tax-credit.html) · [CRA processing times](https://www.canada.ca/en/revenue-agency/services/scientific-research-experimental-development-tax-incentive-program/after-claim.html) |
| NRC IRAP | Target a CAD $50K–$150K contribution for a defined technical R&D project, subject to advisor and project approval. Contact IRAP in Q1 after clearance and incorporation. Allow Q2–Q3 for scoping and agreement and Q3–Q4 for possible reimbursement against eligible incurred costs. | Confirm project start, eligible payroll and contractors and reimbursement timing in the agreement before relying on it. Maintain cash to pay costs first. [NRC IRAP funding and eligibility](https://nrc.canada.ca/en/support-technology-innovation/financial-support-technology-innovation) |
| Mitacs Accelerate | Start with one 4–6 month unit at $15K of academic research funding, typically $7.5K from the company and $7.5K leveraged. Find a supervisor in Q1–Q2 and aim for a Q3 start subject to approval. | Fund a discrete ML evaluation project with a university or college. The award supports the academic project. Carry the company match as separate spending if approved. [Mitacs Accelerate](https://www.mitacs.ca/our-programs/accelerate/) |
| Other Ontario and federal support | Ontario Innovation Tax Credit is 8% refundable if eligible (illustrative $8K–$16K on a $100K–$200K Ontario base before interactions), with a 2028 filing and receipt. The 3.5% Ontario R&D credit offsets tax payable. OCI Collaborate 2 Commercialize with NSERC offers $20K–$50K from each funder in its university stream, with an industry match of $20K–$50K and at least half of that in cash. Screen in Q2 for a late-2027 or 2028 academic project. | Have the accountant model federal/provincial interactions. Choose a scoped academic vehicle and confirm matching costs and IP terms before applying. [Ontario Innovation Tax Credit](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/corporations/provincial-territorial-corporation-tax/ontario-provincial-corporation-tax/ontario-innovation-tax-credit.html) · [Ontario R&D credit](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/corporations/provincial-territorial-corporation-tax/ontario-provincial-corporation-tax/ontario-research-development-tax-credit.html) · [OCI and NSERC](https://www.oc-innovation.ca/programs/collaborate-2-commercialize/) |
| Angel and pre-seed equity | Target an $800K–$1.0M close for the lower-cost plan or $1.05M–$1.25M for the September full-catalog plan. Allow roughly 3–6 months of fundraising and diligence. | Use paid commitments or signed expressions of interest, founder clearance and the lead's staffing plan in diligence. If the close or lead hire misses January, move the staffed start and release dates together. |
| Revenue-based financing | Budget $0 for 2027. Revisit in 2028 after at least six months of stable recurring collections, roughly $25K+ MRR and positive contribution after delivery. Seek illustrative $50K–$100K only if actual cash can cover the repayment share through a downside case. | Compare fees, effective cost, repayment cadence, covenants and security with equity or conventional credit. Lenders set their own revenue and tenure criteria. [BDC financing criteria](https://www.bdc.ca/en/financing/financing-faq) · [BDC recurring-revenue financing](https://www.bdc.ca/en/bdc-capital/growth-transition-capital/financing-offer) |

**Recommendation.** Use the three-contractor plan with a full-time lead from January. It lowers 2027 cash needs, gives the founder dependable daytime delivery coverage and keeps every stream active. Target a September Toronto release for the core workflows and three baseline ML modules, with the wider catalog phased through March 2028. Use the higher-spend schedule if $1.05M and named stream leads are secured before work starts and September availability of the wider catalog matters to signed customers. [Lower-cost delivery dates](03-roadmap.md#lower-cost-parallel-plan)

[Overview](00-overview.md) · [Modules](02-modules.md) · [Roadmap](03-roadmap.md) · [Open questions](07-open-questions.md)
