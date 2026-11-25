# Business Models, Pricing, Unit Economics and GTM for a Managed ERP + CRM Offering for SMBs (5–200 employees, US/Canada), with AI Bots as Add-ons or Entry Wedge

Research date: 2026-11-24. Scope was revised mid-task: the user already builds the voice bots and chatbots, so these notes focus on the ERP/CRM side. Bots appear only as add-ons and entry wedges.

Most figures are from 2024–2026. Many sources are vendor, partner or affiliate blogs, and source quality is flagged inline. "Primary" means a company filing, an official pricing or terms page, or the original report publisher.

---

## 1. Comparable models and their economics: ERP/CRM implementation partners and VARs, MSPs, vertical SaaS, AI-native services and roll-ups

### Takeaway
The economics divide by how much revenue recurs.

**Project-based ERP/CRM partners**
- Revenue comes from implementation fees plus a 5–20% vendor licence commission or revenue share.
- Professional services firms average about 66–69% billable utilization and about 10% EBITDA.
- These firms are valued at about 6–14x EBITDA, with a premium when 35–40% or more of revenue is recurring.

**MSPs (per-user managed model)**
- About 46–50% gross margin and 11–20% EBITDA.

**Vertical SaaS that becomes the system of record** (ServiceTitan)
- Over 95% gross dollar retention (GDR) and over 110% net dollar retention (NDR).

**Implication**
- A managed ERP+CRM vendor should plan to convert project revenue into recurring managed fees.

### Cited Findings

**Odoo partner economics (the most likely platform for a small vendor)**
- **Licence commission:** Odoo pays a recurring commission on Enterprise licences of 10% (Ready), 15% (Silver) and 20% (Gold). It is capped at US$180/month (US$1,728/year) per subscription. — [Odoo Partnership Agreement (primary)](https://www.odoo.com/documentation/master/legal/terms/partnership.html)
- **Other commissions:** 50% on Odoo.sh hosting for Silver/Gold partners, and 82% on maintenance of extra modules. — same source
- **Services revenue:** Partners keep all implementation and service revenue. — same source
- **Land-and-expand:** Odoo's partner pitch says clients bring 2–3 implementations on average. — [Odoo partnership offer (primary)](https://www.odoo.com/knowledge/article/25249)
- **US list price:**
  - Standard is about US$31.10/user/month billed annually, or about $38.90 monthly. It runs on Odoo Online only.
  - Custom is US$46.70–61.00/user/month depending on the snapshot. It adds Studio, multi-company, the external API, Odoo.sh and on-premise hosting.
  - First-year promotions are reported at $24.90 (Standard) and $49 (Custom).
  - Pricing is geolocated.
  - Sources: [Odoo pricing](https://www.odoo.com/pricing); [Capterra](https://capterra.com/p/135618/Odoo/pricing/). The snapshots conflict, so verify on the live page.
- **Implementation hourly rates:**
  - US/Canada developers: $90–150/hour, versus $25–50 in India — [InWizards (agency, self-interested)](https://www.inwizards.com/blog/?p=2521)
  - Offshore-leaning vendors: $20/hour — [Sysgenpro (vendor)](https://sysgenpro.com/resources/odoo-20-per-hour-erp-implementation-pricing-explained-usa)
  - Clutch-listed ERP consultancies: $25–49/hour — [Clutch](https://clutch.co/go-to-review/impliway/412918)
  - No authoritative US survey was found.
- **Recurring support retainers (post go-live):**
  - About $499/month for 10 support hours (1–15 users, 48-hour SLA, monthly health check), or $424 billed annually
  - About $1,499/month for 20 support hours plus 10 development hours
  - Other partners: $200/month for 20 hours or $400 for 50 hours; 8-hour/month entry retainers; a $499/month plan for firms moving off spreadsheets
  - US Odoo support is "typically" $75–200/hour, or $1,000–5,000/month for managed plans
  - Rollover terms vary (for example, 20% rollover, or hours that never expire)
  - Sources: [Ecosire pricing](https://ecosire.com/services/odoo/pricing); [Odoo24x7](https://odoo24x7.odoo.com/pricing); [Clutch/RootLevel](https://clutch.co/profile/rootlevel-innovations/erp-package); [Sysgenpro](https://sysgenpro.com/resources/affordable-odoo-erp-support-services-us) (all vendor pages)
- **ERPNext / Frappe:**
  - Official "Success Packs" are for under 50 users and vanilla, minimal-customisation setups. Core ERPNext is about US$1,800 (about ₹80,000) for 40 hours with 30-day validity.
  - Partners deliver the packs. A separate annual maintenance contract (AMC) is required after go-live.
  - Frappe Cloud hosting is about $50/month with no per-user fee. Typical SMB implementation takes 2–8 weeks.
  - Sources: [Frappe Success Pack (primary)](https://frappe.io/erpnext/success-pack); [Frappe pricing](https://frappe.io/erpnext/pricing)
- **ERPNext third-party estimates:**
  - $5K–12K for a 10–30 user SMB with purchasing, HR and payroll — [Ecosire](https://ecosire.com/blog/erpnext-implementation-cost-guide)
  - $10K–100K+ for partner custom work — [erpresearch](https://erpresearch.com/pricing/erpnext)
  - One partner sells a managed ERPNext subscription at £100/user/month (1–10 users), falling to £80 (11–50 users). This is a direct analogue of a managed-ERP bundle. — [iMorphr](https://imorphr.frappe.cloud/pricing)

**NetSuite / Acumatica VARs**
- **NetSuite implementation:**
  - SMB implementation typically costs 1–5x the annual subscription. A 10–25 user single entity runs $50K–100K in the first year, including $30K–50K of one-time partner services.
  - Other estimates: $25K–50K first-year spend, or $25K–70K for implementation alone.
  - Sources: [Numeric](https://www.numeric.io/blog/netsuite-implementation-cost); [BPM](https://www.bpm.com/insights/netsuite-pricing/); [Closeloop](https://closeloop.com/blog/netsuite-pricing-and-implementation-costs/) (partner/vendor blogs)
- **NetSuite channels:** sold direct, through BPO partners, or through Solution Provider (VAR) partners. — [BPM](https://www.bpm.com/insights/netsuite-pricing/)
- **Acumatica VAR economics:**
  - Acumatica claims "some of the most generous reseller margins" in cloud ERP but publishes no percentage.
  - Partners pay no startup or annual fee. Acumatica says competitors charge $7,500–14,000 to start (its own marketing).
  - Subscriptions are priced on compute resources, not user count.
  - Sources: [Acumatica VAR page (primary)](https://www.acumatica.com/partners/var)
- **Acumatica referral terms:** VARs pay referring parties at least 5% of the Acumatica subscription when a deal closes, and must maintain "Level 2 Margin" or higher. — [Acumatica Partner Referral Program datasheet, 2020 (primary, dated)](https://www.acumatica.com/media/2020/09/Acumatica-Partner-Referral-Program-Datasheet.pdf)
- **Pricing models in older ERP channels:** SAP and Microsoft partners earn a licence resale margin plus a maintenance annuity on top of services. Salesforce consulting partners earn money on services alone. — [Aventis Advisors](https://aventis-advisors.com/who-is-buying-salesforce-consultancies/)

**CRM partner economics**
- **HubSpot Solutions Partners:**
  - Earn 20% of the recurring subscription for up to three years, ending if the customer cancels. Provider-tier partners get 20% for 12 months. HubSpot pays quarterly.
  - The partner package starts at $400/month. Partners must reach Gold tier within 24 months.
  - Partners can waive HubSpot's one-time onboarding fee (worth up to $6,000) if they deliver onboarding themselves.
  - Sources: [HubSpot Rules of Engagement (primary)](https://www.hubspot.com/solutions-partner-resource-center/sales-rules); [HubSpot partner details (primary)](https://www.hubspot.com/partners/solutions/details); [policies](https://www.hubspot.com/partners/solutions-program-policies)

**Professional services and partner operating benchmarks**
- **SPI Research 2025 edition (2024 data, 400+ organisations):** billable utilization was 68.9%, below the 75% target, and EBITDA was 9.8%, the lowest in over a decade. — [Kantata/SPI 2025](https://www.kantata.com/resource/2025-professional-services-maturity-benchmark); [Workday summary](https://blog.workday.com/en-us/4-make-or-break-priorities-professional-service-firms-2025.html)
- **SPI Research 2026 edition (2025 data):** utilization fell to 66.4% (a survey low) and EBITDA was 9.9%, against SPI's expected 15%. High-performing organisations reached 75.0% utilization, versus 64.9% for the rest. — [Certinia analysis](https://www.certinia.com/blog/analyzing-the-2026-spi-research-professional-services-maturity-benchmark-report/); [Rocketlane](https://rocketlane.com/blogs/professional-services-maturity-index-2026)
- **Valuation multiples:**
  - ERP/CRM implementation firms trade at 6–10x EBITDA according to one advisor and 8–14x according to another. Solganick's Q3 2025 range for IT consulting is 10.6–13.0x EV/EBITDA.
  - Firms with 40%+ recurring revenue trade at a "meaningful premium". A worked example puts a Microsoft partner with 35% recurring revenue at 9–11x.
  - Across 1,051 IT services deals, the median EV/Revenue is 1.1x (quartiles 0.6x and 1.9x).
  - Sources: [Vestara (advisor marketing)](https://vestaraadvis-yrv4rarv.manus.space/industries/it-consulting); [Solganick Q3 2025](https://solganick.com/technology-services-mergers-acquisitions-report-update-q3-2025/); [Aventis IT services multiples](https://aventis-advisors.com/it-services-valuation-multiples/)

**MSPs (the per-user managed-service analogue)**
- **Per-user pricing:**
  - Kaseya's 2023 survey (n=1,091): about 22% of per-user-pricing MSPs charge $50–100/user/month — [Kaseya](https://www.kaseya.com/?p=15042)
  - 2025 vendor estimates: $110–175/user/month standard, $200–275 security-inclusive, up to $400 in regulated sectors — [N-able](https://www.n-able.com/blog/msp-pricing-guide)
  - Another estimate: $100–250/user/month — [Huntress](https://www.huntress.com/msp-guide/building-your-msp-pricing-model)
- **Gross margin:** the average managed-services gross margin was 46.2% in Q2 2024. — [ConnectWise/Service Leadership (primary)](https://www.connectwise.com/company/press/releases/2024-08-06-service-leadership-q2-data-report)
- **EBITDA and growth:** MSP adjusted EBITDA was 11.1% in Q4 2024 (10.3% in Q4 2023), and managed-services growth was -0.2% in Q4 2024. — [GlobeNewswire, Feb 13 2025 (primary)](https://globenewswire.com/news-release/2025/02/13/3025918/27043/en/Service-Leadership-Index-Q4-Data-Reveals-MSP-Profitability-Remains-Near-Historic-Highs-While-Managed-Service-Revenue-Growth-Continues-to-Slowdown.html)
- **Best-in-class and buyer benchmarks:**
  - Best-in-class MSPs reach about 50% gross margin and about 20% EBITDA — [Kaseya](https://www.kaseya.com/blog/the-ten-most-important-msp-business-metrics-how-do-you-measure-up/)
  - M&A buyers look for 50%+ gross margin — [FOCUS 2024](https://focusbankers.com/wp-content/uploads/2024/03/FOCUS-MSP-Group-2024-MA-Outlook.pdf)

**Vertical SaaS**
- **ServiceTitan:** reported over 95% GDR and over 110% NDR for the 10 quarters before its S-1, and again in FY2025 and FY2026. It had about 10,800 active customers in FY2026. — [Meritech S-1 breakdown](https://meritechcapital.com/blog/servicetitan-s-1-breakdown); [ServiceTitan FY2025 (primary)](https://www.servicetitan.com/press/servicetitan-fiscal-fourth-quarter-results-fy2025); [FY2026 (primary)](https://investors.servicetitan.com/news-releases/news-release-details/servicetitan-announces-fiscal-fourth-quarter-and-full-fiscal)
- **Jobber:** priced by seat, at about $30/month (1 user), $127 (5 users) and $262 (10 users) as of August 2025. Sacra estimates 2023 revenue at about $150M, up from $100M (a third-party estimate). — [Carly](https://www.usecarly.com/blog/jobber-vs-housecall-pro/); [Sacra](https://sacra.com/research/jobber)
- **Housecall Pro:** about $59/$149/$299/month billed annually, plus about $100 per extra user. — [Carly](https://www.usecarly.com/blog/jobber-vs-housecall-pro/)

**AI-native services, services-as-software and roll-ups (context for the managed-service model)**
- **Sequoia**, "Services: The New Software" (Julien Bek, March 5, 2026): the next $1T company will be "a software company masquerading as a services firm". It contrasts copilots with autopilots that sell the finished output. — [Sequoia (primary)](https://sequoiacap.com/article/services-the-new-software)
- **Foundation Capital** sizes service-as-software at $4.6T, combining outsourced services with in-house salaries. It cautions that AI services' costs grow with usage. — [Foundation Capital](https://foundationcapital.com/ai-service-as-software/)
- **Emergence Capital** coined "AI-native services" in 2024. — [Emergence](https://emcap.com/ai-native-services)
- **General Catalyst** has $1.5B in AI-enabled roll-ups and targets at least double the EBITDA of acquired firms.
  - GC-backed Titan MSP ($74M) reports pilots automating 38% of MSP tasks.
  - Gruve claims 80% gross margin at $15M revenue (founder-reported).
  - Mayfield projects 80–90% gross margins if AI does 80% of the work (a projection).
  - Source: [TechCrunch, Sept 28 2025](https://techcrunch.com/2025/09/28/the-ai-services-transformation-may-be-harder-than-vcs-think/)
- **Bessemer, August 2025:** AI "Shooting Stars" run about 60% gross margin and "Supernovas" about 25% (often negative). — [Bessemer](https://www.bvp.com/atlas/the-state-of-ai-2025)

### Inferences
- The licence commission is too small to carry the business.
  - Odoo Gold pays 20% of $31–61/user/month, capped at $180/month per subscription. For 20 users on Standard that is about $124/month.
  - HubSpot pays 20% for 3 years. Acumatica referrals pay at least 5%.
  - The economics must come from implementation fees plus a recurring managed support and administration fee.
- **Margin targets:** the vendor should plan for a blended 45–60% gross margin, at or above the MSP average of 46–50%. It should plan for more than 70% billable utilization on delivery staff, since SPI's healthy floor is 70% and its target is 75%.
- **Valuation:** moving recurring revenue above 40% of the mix moves the business from project-shop multiples toward MSP and SaaS-hybrid multiples.
- **Pricing comparables:** the iMorphr managed ERPNext model (£80–100/user/month all-in) and MSP per-user pricing ($100–250) are the closest pricing comparables for a "managed ERP+CRM" subscription.

### Gaps
- No primary percentages were found for Acumatica or NetSuite VAR margin tiers; they are in partner-only documents.
- No US-specific survey of Odoo partner revenue, utilization or headcount was found.
- No public metrics were found for small ERP partners' churn or support-contract attach rates.

---

## 2. Pricing structures for an ERP+CRM bundle, and SMB willingness to pay

### Takeaway
The public price anchors for a small company's ERP and CRM stack are:
- **Odoo:** $31–61/user/month
- **Zoho One:** $37/employee/month (all-employee plan) or $90/user/month (flexible user plan)
- **HubSpot Starter:** $15/seat/month
- **QuickBooks Online Advanced:** about $235–340/month
- **QuickBooks Enterprise:** about $1,900–5,400/year

Managed per-user services (MSP $100–250/user/month, managed ERPNext about £80–100/user/month) show that SMBs will pay several times the software list price when support and administration are bundled in. Median SaaS spend is about $3,200/employee/year for 10–49 employee firms and about $6,200 for 50–249.

### Cited Findings
- **Zoho One** (the closest "all-in-one suite" comparable):
  - All-Employee plan: $37/employee/month billed annually, or $45 monthly. It must cover every employee on payroll.
  - Flexible User plan: $90/user/month, or $105 monthly.
  - Sources: [Zoho small-teams pricing (primary)](https://www.zoho.com/r/small-teams/pricing); [Capterra](https://www.capterra.com/p/166175/Zoho-One/pricing/)
- **HubSpot Starter Customer Platform:** from $15/seat/month annually, or $20 monthly. Promotions of $7–10/seat appear at times. — [HubSpot (primary)](https://www.hubspot.com/products/crm/starter); [Capterra](https://www.capterra.com/p/152373/HubSpot-CRM/pricing/)
- **Odoo:** about $31.10 (Standard) or $46.70–61.00 (Custom) per user/month in the US. — [Odoo](https://www.odoo.com/pricing)
- **QuickBooks (the incumbent customers will migrate from):**
  - QBO Advanced was $235/month (2025 listings), $275 after a July 2025 increase, and is listed at $340 in 2026 pages. Intuit raises prices roughly once a year.
  - QuickBooks Enterprise is about $1,873–5,364/year.
  - Sources: [NerdWallet](https://www.nerdwallet.com/article/small-business/business-software/how-much-does-quickbooks-cost); [G2](https://www.g2.com/products/quickbooks-online-advanced/pricing); [TechRepublic, June 2025](https://www.techrepublic.com/article/quickbooks-online-vs-enterprise/)
- **Intuit's accountant channel:** Intuit runs accountant-specific offers for QBO Advanced, so accountants sit in the purchase path. — [Intuit "talk to your accountant" page (primary)](https://quickbooks.intuit.com/accounting/advanced-features-ws/)
- **Implementation fee anchors:**
  - ERPNext packs: about $1,800 for 40 hours — [Frappe](https://frappe.io/erpnext/success-pack)
  - ERPNext SMB projects: $5K–12K — [Ecosire](https://ecosire.com/blog/erpnext-implementation-cost-guide)
  - NetSuite SMB partner services: $25K–70K — [Numeric](https://www.numeric.io/blog/netsuite-implementation-cost)
  - HubSpot onboarding: up to $6,000 — [HubSpot](https://www.hubspot.com/partners/solutions/details)
- **Recurring support anchors:**
  - Odoo support retainers: $200–1,499/month for 8–50 hours; managed plans $1,000–5,000/month — [Ecosire](https://ecosire.com/services/odoo/pricing); [Sysgenpro](https://sysgenpro.com/resources/affordable-odoo-erp-support-services-us)
  - Managed ERPNext: £100/user/month (1–10 users) or £80 (11–50 users), all-in — [iMorphr](https://imorphr.frappe.cloud/pricing)
  - MSP per-user: $100–250/user/month — [N-able](https://www.n-able.com/blog/msp-pricing-guide); [Huntress](https://www.huntress.com/msp-guide/building-your-msp-pricing-model)
- **SMB SaaS spend per employee:**
  - Productiv 2025 medians: about $3,200/employee/year (10–49 staff), $6,200 (50–249) and $8,400 (250–499), via a secondary summary — [Mekari](https://expense.mekari.com/en/blog/average-software-spend-per-employee-statistics)
  - Zylo 2025 (enterprise-skewed): $4,830 average, up 21.9% year over year — [Zylo (primary)](https://zylo.com/news/2025-saas-management-index)
  - Vertice: a $5,800 median for 50–250 staff — [Vertice](https://www.vertice.one/blog/saas-spend-per-employee)
- **Add-on bot pricing models** (for context only, per the revised scope):
  - Usage-based pricing for AI agents, such as Intercom Fin at $0.99 per outcome — [Intercom (primary)](https://www.intercom.com/help/en/articles/8205718-fin-pricing)
  - a16z's expected voice-agent model is a platform fee plus usage — [a16z, Jan 2025](https://a16z.com/ai-voice-agents-2025-update/)
  - B2B collections contingency fees run 10–25% for accounts under 90 days — [Resolve](https://resolvepay.com/blog/how-much-b2b-collection-agencies-charge)

### Inferences
- **Worked bundle example** (inference): a 25-employee distributor with 12 ERP users and 6 CRM users.
  - Software cost: Odoo Custom at about $47–61 × 12, roughly $560–730/month, which includes CRM in Odoo.
  - A managed tier at about $100–150/user/month, all-in with licences, support hours, hosting, minor changes and one or two bots, gives $1,200–1,800/month (about $14K–22K/year).
  - Setup fee: $5K–15K.
  - That is roughly 18–27% of the firm's estimated total SaaS spend (25 × $3,200 = $80K/year).
  - It is defensible only if it replaces QuickBooks Advanced ($275–340/month), a standalone CRM and inventory tools, plus some admin labour.
- **Two credible structures:**
  - (a) Per-user managed pricing (MSP or iMorphr style) with a user-band minimum.
  - (b) Zoho-style all-employee flat tiers (for example, a Starter / Growth / Scale tier by employee band).
  - Both should include capped monthly support or admin hours, priced change-orders, and bots as priced add-ons with usage allowances.
- **Bots as margin levers:** bots fit as add-on SKUs that raise ARPA, which correlates with retention (see section 3). Including one bot in the base tier can act as the wedge.

### Gaps
- No survey data was found on SMB willingness to pay specifically for managed ERP (as opposed to software alone).
- Microsoft Dynamics 365 Business Central and Acumatica list prices were not collected within the tool budget.
- No evidence was found comparing per-user and flat-tier conversion rates for SMB ERP.

---

## 3. SaaS benchmarks for SMB-focused companies (churn, NRR, CAC payback, LTV/CAC)

### Takeaway
SMB SaaS typically sees:
- about 2–5% monthly logo churn, rising to about 6% when ARPA is under $25
- NRR of about 97–102% at the median
- blended CAC payback of 16–24+ months

Higher ARPA (over $500/month) is strongly associated with net retention above 100%. An ERP+CRM system of record can reach ServiceTitan-like retention (over 95% GDR).

### Cited Findings
- **ChartMogul 2023 retention report:**
  - Only 2.7% of SaaS businesses with ARPA under $10/month have NRR over 100%, versus 41.1% of those with ARPA over $500/month — [ChartMogul (primary)](https://chartmogul.com/saas-retention-report/)
  - Median monthly churn is 6.1% for ARPA under $25. The best companies stay under 2% monthly, falling below 1% as ARPA rises — [ChartMogul](https://chartmogul.com/blog/retention-benchmarks-and-insights/)
- **SaaS Capital 2025 retention benchmarks** (September 18, 2025): for ACV $25K–50K, median NRR is 102% (quartiles 97% and 111%). Firms with NRR of 110% or more grew faster than the 24% median for companies over $1M ARR. — [SaaS Capital (primary)](https://www.saas-capital.com/research/saas-retention-benchmarks-for-private-b2b-companies/)
- An aggregator cites SaaS Capital's 2025 SMB median NRR (ACV under $25K) at about 97%. — [Stripo Research](https://research.stripo.email/ssential-saas-business-metrics-2026) (not verified on the primary page)
- **SMB churn bands** from aggregators: under 2% monthly is best-in-class, 3–7% typical, over 8% a warning. SMB annual logo churn is 10–14% (attributed to ChartMogul 2025). — [Stripo](https://research.stripo.email/aas-churn-rate-benchmarks-2026---research-report---stripo); [Stealth Agents](https://stealthagents.com/research/saas-churn-rate-statistics-2026)
- **SMB gross revenue retention:** a median of 70–82% per CRV, which conflicts with ProfitWell-attributed annual gross revenue churn of 6–10%. — [CRV](https://crv.com/content/saas-churn-rate)
- **KeyBanc/Sapphire 2025 Private SaaS Survey** (published November 13, 2025): third-party extraction reports gross margin in the mid-to-high 70s, a blended CAC payback of about 24 months, and about 37 months for new customers only. — [Sapphire (primary landing page)](https://info.sapphireventures.com/2025-keybanc-capital-markets-sapphire-ventures-saas-survey); [scorecard](https://cfo.successcoaching.co/docs/scorecard) (unverified)
- **Benchmarkit:** median B2B SaaS CAC payback was 16 months in 2025 and 18 months in 2024. — [Benchmarkit](https://online.flippingbook.com/view/1018476450)
- **ServiceTitan** (system of record for SMB contractors): over 95% GDR and over 110% NDR. — [ServiceTitan (primary)](https://www.servicetitan.com/press/servicetitan-fiscal-fourth-quarter-results-fy2025)
- **SaaStr (Jason Lemkin):** high early churn was the common thread in his SMB SaaS losses. — [SaaStr](https://www.saastr.com/the-challenge-with-smb-saas)

### Inferences
- **Worked LTV example:**
  - Assumptions: $1,500/month ARPA, 55% gross margin, 1.5% monthly churn (plausible for a system of record).
  - LTV ≈ 1,500 × 0.55 / 0.015 ≈ $55K.
  - At 3% monthly churn, LTV ≈ $27.5K.
  - With CAC of $6K–12K, LTV/CAC is about 2.5–9x.
  - Payback is about 7–15 months on gross margin, before setup-fee contribution. Setup fees that cover implementation cost can shorten payback sharply.
- A $1,000–2,000/month ARPA puts the bundle in ChartMogul's over-$500 band, where expansion-driven NRR is common. A bot-only entry at about $100–300/month falls in the high-churn band, so upgrades need to happen quickly.

### Gaps
- OpenView benchmarks for 2024–2026 were not located.
- The primary KeyBanc/Sapphire PDF was not accessed.
- No benchmarks were found specifically for hybrid "SaaS + managed service" SMB businesses.

---

## 4. Go-to-market channels for ERP/CRM sales (accountants, ProAdvisors, associations, MSPs, outbound, content) and CAC by channel

### Takeaway
Referrals dominate new business for ERP vendors, MSPs and integrators. Partner and referral CAC is the lowest of any channel in every benchmark found, while outbound is the costliest and rarely works at ACVs under $5K.

Accountants are the natural referral partners for ERP:
- They influence QuickBooks purchases.
- Vendor accountant programmes pay referral bounties or revenue shares of 5–20%.
- QuickBooks ProAdvisor has 250K+ members.

### Cited Findings
- **Referrals as the top channel in adjacent markets:**
  - MSPs: referrals were the top acquisition strategy (43% of respondents), ahead of cold outreach (18%) and SEO/website (16%) — [MSP Success survey](https://mspsuccess.com/inside-the-client-acquisition-playbook-msps-share-their-secrets/)
  - Security integrators: referrals and networking were the top lead sources in a 2015 survey of 100 salespeople — [IPVM](https://ipvm.com/reports/sales-leads-survey-results) (older, adjacent market)
- **ERP-specific lead sources:**
  - ProShop ERP (a manufacturing ERP vendor) says over 90% of clients came from inbound or referrals, with organic SEO first and referrals second — [Starter Story](https://www.starterstory.com/businesses/proshop-erp/growth-channels) (single company, self-reported)
  - ERP VARs often lack marketing support, and vendor-supplied referral leads "can dry up", so VARs need their own pipeline — [SmithDigital](https://smithdigital.io/blog/erp-software-lead-generation-tactics-that-really-work)
  - A GLG survey of ERP VARs exists but is not public — [GLG](https://glginsights.com/network-survey-erp-vars/)
- **CAC by channel (blended B2B, Optifai, 939 companies):** partner/referral $150, inbound $200, paid ads $350, outbound $400, events $500, with an average of $300. — [Optifai](https://optif.ai/learn/questions/cac-by-channel/) (aggregator)
- **SMB CAC by channel (weakly sourced):** referral $171, SEO $560, paid search $802, outbound $1,980. — [Stealth Agents](https://stealthagents.com/research/smb-customer-acquisition-cost-statistics-2026); [Phoenix Strategy Group](https://www.phoenixstrategy.group/blog/cac-benchmarks-by-channel-2025)
- Outbound rarely works for ACVs under $5K. — [Fungies](https://fungies.io/saas-customer-acquisition-cost-guide)
- **Accountant and bookkeeper programmes:**
  - QuickBooks ProAdvisor has 250K+ partners and offers wholesale pricing, certification and directory listings — [GrowSurf](https://growsurf.com/examples/accounting-software-referral-programs/)
  - BILL runs a referral commission plus a tiered console programme with directory placement — [BILL (primary)](https://www.bill.com/accountant-resource-center/articles/your-accountant-partner-program-benefits)
  - Neat pays a 10% referral commission or up to 40% wholesale margin — [Accounting Today](https://www.accountingtoday.com/news/the-neat-company-opens-new-accountant-partner-program)
  - ADP and Rightworks run revenue-share programmes — [Rightworks](https://www.rightworks.com/partners/become-partner/referral-partners/)
  - Intuit markets QBO Advanced through accountants — [Intuit](https://quickbooks.intuit.com/accounting/advanced-features-ws/)
- **ERP vendor referral mechanics:**
  - Acumatica certified VARs pay referrers at least 5% of the subscription when a deal closes — [Acumatica datasheet](https://www.acumatica.com/media/2020/09/Acumatica-Partner-Referral-Program-Datasheet.pdf)
  - Odoo runs an affiliate programme alongside its partner commissions — [Odoo affiliate](https://www.odoo.com/affiliate)
  - HubSpot pays partners a 20% revenue share for 3 years — [HubSpot](https://www.hubspot.com/solutions-partner-resource-center/sales-rules)
- **MSPs as partners or competitors:** GC-backed Titan MSP is rolling up and AI-enabling MSPs. — [TechCrunch](https://techcrunch.com/2025/09/28/the-ai-services-transformation-may-be-harder-than-vcs-think/)

### Inferences
- **Proposed referral offer** (benchmarked on Acumatica's 5% floor, HubSpot's 20% for 3 years, Neat's 10% and BILL's bounties): about 10–15% of recurring managed fees for 12–36 months, or a flat bounty of about $500–2,000 per closed client, paid to bookkeepers, CPAs and fractional CFOs.
- Accountants see the signals that a client is outgrowing QuickBooks: inventory, multi-entity, AR ageing and reporting pain. An AR-collections or reporting add-on gives them a concrete reason to refer.
- **Realistic CAC:** aggregator CAC figures ($150–800) reflect low-ACV SaaS. For $15K–25K/year ERP+CRM deals with a founder-led sales process, $3K–15K blended CAC is a more realistic planning range (an unsourced inference).
- **Vertical focus:** focusing on one or two verticals (for example, distributors or field services) makes associations, trade shows, templated demos and SEO case studies reusable. Following ProShop's pattern of SEO plus referrals is the cheapest compounding path.

### Gaps
- No primary CAC figures were found for accountant-referred ERP deals, industry association sponsorships or YouTube for ERP partners.
- Gusto's and QuickBooks ProAdvisor's referral payout terms were not found.
- No public ERP VAR lead-source survey exists; GLG's is gated.

---

## 5. Lessons from failures and pivots, and the risks of "customised for everyone"

### Takeaway
The recurring failure modes are:
- ERP projects going over budget (30–47% of projects in Panorama surveys) and delivering few of the expected benefits
- services firms falling to about 10% EBITDA when utilization drops
- labour-heavy "services-as-software" firms failing to automate (Bench, December 2024)
- AI rework eroding the expected margin gains

Bespoke customisation for every client recreates these economics.

### Cited Findings
- **ERP overruns:**
  - Panorama's 2026 report found 30% of ERP projects over budget, versus 47% in the 2023 report. The top cause was needing extra technology to fill gaps missed in selection, followed by extra staffing, data issues, underestimated consulting fees and scope creep — [Panorama](https://www.panorama-consulting.com/why-erp-projects-go-over-budget-and-how-to-prevent-it/); [Accounting Today](https://www.accountingtoday.com/news/one-third-of-enterprise-software-projects-have-time-cost-overruns-says-report)
  - An older Panorama study found over half of companies realise 30% or less of the benefits they expected — [Computerworld](https://www.computerworld.com/article/1516480/widespread-discontent-persists-with-erp-projects.html)
- **Services margin squeeze:** SPI's 2025–2026 benchmarks show utilization at 66–69% and EBITDA at about 10%, the lowest in a decade. — [Certinia](https://www.certinia.com/blog/analyzing-the-2026-spi-research-professional-services-maturity-benchmark-report/)
- **Bench Accounting** (Vancouver, more than $100M raised):
  - Shut down on December 27, 2024 after a bank called in its venture debt
  - Ex-employees cited inefficiency, too little automation, high turnover and declining service quality
  - Thousands of SMBs temporarily lost access to their books
  - Employer.com acquired it on December 30, 2024
  - Sources: [TechCrunch](https://techcrunch.com/2024/12/27/bench-shuts-down-leaving-thousands-of-businesses-without-access-to-accounting-and-tax-docs); [TechCrunch follow-up](https://techcrunch.com/2025/01/03/inside-the-wild-fall-and-last-minute-revival-of-bench-the-vc-backed-accounting-startup-that-imploded-over-the-holidays)
- **Roll-up skepticism:**
  - "Workslop": 40% of 1,150 surveyed workers absorb low-quality AI output, at about 2 hours per instance, so cutting staff removes the people who catch errors — [TechCrunch](https://techcrunch.com/2025/09/28/the-ai-services-transformation-may-be-harder-than-vcs-think/)
  - Fortune argues labour-heavy firms don't become software-like just by adding AI — [Fortune](https://fortune.com/2025/06/27/ai-rollup-investment-strategy/)
- **AI agency churn:** clients cancel once the automation seems to "run itself". This is relevant if bots are sold standalone. — [Medium/Automation Labs](https://medium.com/@automation.labs/ai-automation-agencies-charge-5k-a-client-few-get-five-f0e9ad0b5dde)
- **Frappe's productised model:** Frappe explicitly designs Success Packs for "vanilla", minimal-customisation deployments and sends complex needs (integrations, custom apps, over 50 users) to partners. That is a productisation template. — [Frappe](https://frappe.io/erpnext/success-pack)

### Inferences
- **Mitigations for "customised for everyone":**
  - Pick one or two verticals.
  - Ship templated configurations, as Frappe's packs do.
  - Cap included customisation hours per tier and price change-orders at $90–150/hour (the US rate band).
  - Measure utilization monthly.
- **Data portability:** the Bench case makes data portability and continuity guarantees (export rights, escrow, standard Odoo/ERPNext data models) a sales asset for a small vendor that SMBs may worry will fail.

### Gaps
- No documented case studies were found of small US Odoo or ERPNext partners failing or pivoting.
- No SMB-specific (under 200 employees) ERP failure-rate data was found; Panorama's samples skew mid-market.

---

## 6. Structuring the first offer: bot wedge vs leading with ERP

### Takeaway
No head-to-head evidence was found. The indirect evidence favours a two-step approach:
1. Land with a fast-ROI bot that the user already builds. Collections or AR fits best for B2B; missed-call capture fits for local services.
2. Connect the bot to a lightweight CRM, then sell the ERP migration as a fixed-scope package.

Retention and ARPA evidence shows the ERP/CRM system of record is where durable revenue comes from, so the wedge needs a contracted path to expand.

### Cited Findings
- **a16z** (January 2025): voice-agent founders land with a "wedge" of calls and expand, and debt collection is an early-monetising category. — [a16z](https://a16z.com/ai-voice-agents-2025-update/)
- **Expansion is normal in ERP accounts:** Odoo says clients bring 2–3 implementations on average. — [Odoo](https://www.odoo.com/knowledge/article/25249)
- **ERP as the first purchase carries the most risk and the slowest payback:**
  - NetSuite SMB first year: $25K–100K — [Numeric](https://www.numeric.io/blog/netsuite-implementation-cost)
  - 30–47% of ERP projects go over budget — [Panorama](https://www.panorama-consulting.com/why-erp-projects-go-over-budget-and-how-to-prevent-it/)
  - Even vanilla ERPNext takes 2–8 weeks — [Frappe](https://frappe.io/erpnext/pricing)
- **Collections ROI is easy to see** because agencies already charge 10–25% contingency on young B2B debt. — [Resolve](https://resolvepay.com/blog/how-much-b2b-collection-agencies-charge)
- **The missed-call statistic is weak:**
  - The widely cited "62% unanswered" comes from a 2016 411 Locals study of 85 businesses
  - Newer figures range from 28% (CallRail) to 44% (Invoca, per secondary source)
  - Sources: [Quo](https://www.quo.com/blog/small-business-callback-statistics/); [CallRail](https://www.callrail.com/blog/missed-calls-cost-businesses-more-than-ever)
- **ARPA and retention:** NRR above 100% is about 15 times more common at ARPA over $500/month than under $10. — [ChartMogul](https://chartmogul.com/saas-retention-report/)

### Inferences
- **Suggested offer ladder:**
  1. A 30–60 day paid pilot of one bot, connected to a CRM from day one (Odoo CRM, or HubSpot Starter at $15/seat).
  2. A CRM tier with managed administration.
  3. A fixed-scope ERP migration off QuickBooks Advanced ($275–340/month), priced as a package ($5K–15K), with the pilot fee credited toward it.
  4. A managed ERP+CRM subscription ($100–150/user/month or employee-band tiers), with bots as add-ons.
- **Choosing the wedge:**
  - For B2B (distributors, wholesalers), collections ties directly into the ERP finance module and into accountant referrals.
  - For local services, a missed-call or receptionist bot is more vivid, but the hard ROI evidence is weaker.

### Gaps
- No primary data was found comparing time-to-ROI for a bot-first versus ERP-first entry.
- No public bot-to-ERP expansion or attach rates were found for any vendor.
- No vendor was found running exactly this bundle (managed ERP+CRM plus AI bots) for SMBs with published metrics.
