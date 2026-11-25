# ERP/CRM Build Stack, Licensing, Hosting and Per-Customer COGS for a Managed SMB Bundle (US/Canada)

**Research date:** 2026-11-24. Unless noted, prices were read from vendor pages on that date ("fetched 2026-11-24"). Many vendor pages show no effective date; where one was shown it is quoted.

**Scope:** the ERP and CRM layer only. On the coordinator's instruction, voice-bot, chatbot and LLM cost research was dropped because the user is already building those bots. The bots are treated here only as API clients of the ERP/CRM.

## 1. Open-source ERP/CRM bases and their licences for hosted, white-label resale

### Takeaway
- **Odoo Community (LGPLv3) and ERPNext (GPLv3)** can both be hosted as a paid managed service and rebranded. Running the software for customers is not distribution, so it does not trigger source disclosure.
- **Odoo Enterprise** cannot be resold or sublicensed by the vendor. Each customer needs its own per-user subscription, and a partner licence covers only test and development environments.
- **The modern CRMs (Twenty, EspoCRM, SuiteCRM) are AGPLv3.** If you modify them and serve them over a network, you must offer the modified source to those users.

### Cited Findings
**Odoo**
- Odoo Community Edition is LGPLv3. — [Odoo Licenses (19.0)](https://www.odoo.com/documentation/19.0/legal/licenses.html)
- The Odoo Enterprise Edition License v1.0 says the software "can only be used (executed, modified, executed after modifications) with a valid Odoo Enterprise Subscription for the correct number of users". It also states: "It is forbidden to publish, distribute, sublicense, or sell copies of the Software or modified copies of the Software." — [Odoo Licenses](https://www.odoo.com/documentation/19.0/legal/licenses.html)
- Under that licence you may "develop Odoo modules based on the Software and distribute them under the license of your choice", if that licence is compatible. The copyright and permission notice must appear in all copies. — [Odoo Licenses](https://www.odoo.com/documentation/19.0/legal/licenses.html)
- A Partnership Agreement with Odoo S.A. grants the same permissions, but only in a testing or development environment. — [Odoo Licenses](https://www.odoo.com/documentation/19.0/legal/licenses.html)
- The Enterprise Subscription Agreement says:
  - Charges are based on "the number of Users, Light Users and the Subscription Plan" (§5.1).
  - Renewals below list price rise "by up to 7% per year" (§5.2).
  - The customer may work through an Odoo Partner or directly with Odoo SA (§4.6).
  - The licence "is revoked immediately" when the subscription ends (§3).
  - Self-hosting customers must allow Odoo SA to verify licence validity (§6.1).
  - The agreement text read does not explicitly address hosting for third parties or debranding.
  — [Odoo Enterprise Subscription Agreement](https://www.odoo.com/documentation/19.0/legal/terms/enterprise.html)
- White-label and debranding modules are sold on the Odoo Apps store:
  - "White Label" (is_odoo_whitelabel), OPL-1.
  - Webkul backend debranding.
  - Cerevantix "remove Powered by Odoo", OPL-1.
  - Odoo forum replies note that such debranding modules are third-party and not developed or supported by Odoo.
  — [Odoo Apps: is_odoo_whitelabel](https://apps.odoo.com/apps/modules/18.0/is_odoo_whitelabel); [Webkul debranding docs](https://webkul.com/blog/odoo-backend-debranding-documentation/); [Odoo Apps: cerevantix_remove_powered_by_odoo](https://apps.odoo.com/apps/modules/17.0/cerevantix_remove_powered_by_odoo); [Odoo forum thread 93041](https://www.odoo.com/forum/help-1/if-odoo-does-not-allow-to-remove-powered-by-odoo-then-why-odoo-de-branding-module-is-available-at-odoo-official-website-93041)
- No official Odoo trademark policy was found. An old forum answer about the OpenERP trademark advised asking the company directly. — [Odoo forum: OpenERP trademark conditions](https://www.odoo.com/forum/help-1/what-are-the-conditions-of-use-the-the-openerp-trademark-8542)

**ERPNext, Frappe and the other ERPs**
- ERPNext is GPLv3. The Frappe Framework is reported as MIT, but only by a non-official comparison site. — [Wikipedia: ERPNext](https://www.wikipedia.com/wiki/ERPNext); [ERPNext docs: Open Source](https://docs.erpnext.com/docs/v12/user/manual/en/introduction/open-source); [AlternativeTo ERPNext](https://alternativeto.net/software/erpnext/)
- Dolibarr is GPLv3-or-later and Tryton is GPLv3. iDempiere is GPLv2 per Wikipedia, while one ONES article lists Apache 2.0, so the sources conflict. — [Wikipedia: List of ERP software packages](https://en.wikipedia.org/wiki/List_of_ERP_software_packages); conflicting: [ONES blog](https://ones.com/blog/?p=1099910)

**CRMs**
- EspoCRM is AGPLv3 per its GitHub repository, with about 3.7k stars. This resolves an earlier conflict with a blog that listed it as MIT. — [GitHub espocrm/espocrm](https://github.com/espocrm/espocrm)
- Twenty has about 61.4k stars and 10.2k forks on GitHub. Its repo page did not render the licence text. Comparison blogs list its core as AGPL-3.0, and one says enterprise components carry a separate commercial licence. It is under three years old. — [GitHub twentyhq/twenty](https://github.com/twentyhq/twenty); [Marmelab Open Source CRM benchmark 2026](https://marmelab.com/blog/2026/01/09/open-source-crm-benchmark-2026); [ossalt Twenty vs SuiteCRM vs EspoCRM 2026](https://ossalt.com/guides/twenty-vs-suitecrm-vs-espocrm-2026)
- SuiteCRM is AGPL-3.0. It is on version 8.9, with security releases still shipping for 7.x. — [ossalt comparison](https://ossalt.com/guides/twenty-vs-suitecrm-vs-espocrm-2026)

### Inferences
- **Odoo Community.** You may host it, modify it and rebrand the UI, and charge for hosting, services and your own modules. Under LGPL, your separately-written modules can stay proprietary even if distributed. Do not use the "Odoo" name or logo as your product brand; keep the licence and copyright notices.
- **ERPNext (GPLv3).** Hosting is fine. If you ever *distribute* ERPNext or apps derived from it, for example by shipping an on-premise package to a customer, those apps must be GPL-compatible and their source provided. Pure SaaS avoids this.
- **AGPL CRMs (Twenty, EspoCRM, SuiteCRM).** Any modification to the CRM itself must be offered as source to your hosted users. To keep proprietary logic private, put it in separate services that call the CRM's API rather than in forks of the CRM.
- **Odoo Enterprise in a vendor bundle.** It works only as a pass-through. The customer holds the subscription, ideally through you as an Odoo partner. It cannot be a white-label component of your own branded product.
- **Prefer the ERP's built-in CRM.** Odoo CRM and ERPNext CRM avoid a second system, duplicate customer masters, and the AGPL obligations of a standalone CRM. A separate CRM such as Twenty or EspoCRM only makes sense for customers who want CRM-only, or who want a modern UI in front of a QuickBooks-based back office.

### Gaps
- The Odoo trademark/brand-use policy and the full Odoo Partner Agreement (tiers, fees, Enterprise reseller margins) were not found.
- Twenty's exact LICENSE text, including any /ee commercial licence, was not read directly.
- First-party confirmation of the Frappe Framework MIT licence was not obtained.

## 2. Module maturity, North American accounting/tax fit, QuickBooks integration, talent pool

### Takeaway
- **Odoo** has the most mature, broadest module set (accounting, inventory, purchasing, MRP, CRM) and the largest partner pool. The US has the most Odoo partners, about 250.
- **Odoo Community accounting has real gaps** compared with Enterprise: bank synchronization and the bank-reconciliation UI and some financial reports are Enterprise-only, and the OCA fills them.
- **Odoo Canada** covers GST/HST/PST fiscal positions but has no payroll. Avalara AvaTax integrates officially with Odoo.
- **ERPNext** has a built-in TaxJar integration for US sales tax but no official QuickBooks connector. Its QuickBooks migrator was removed in January 2025.

### Cited Findings
**Odoo Community vs Enterprise accounting**
- Odoo docs (v13) state that bank synchronization is not included in Community. A 2026-era comparison lists automated bank sync and bank reconciliation with matching models as Enterprise-only, with OCA add-ons for Community. — [Odoo docs v13: bank synchronization](https://www.odoo.com/documentation/user/13.0/accounting/bank/feeds/bank_synchronization.html); [Glorium Tech Community vs Enterprise](https://gloriumtech.com/odoo-community-vs-enterprise/)
- An Odoo forum answer says bank reconciliation is an Enterprise feature. — [Odoo forum: bank reconciliation in Community](https://www.odoo.com/forum/help-1/bank-reconciliation-in-community-edition-182311)
- Sources conflict on reports:
  - One blog says Community lacks balance sheet, P&L, financial reports, budgets and currency valuation.
  - An older (Odoo 9-10 era) analysis says Community has the P&L, balance sheet, GL and trial balance, while the cash flow statement and aged receivables/payables are Enterprise-only.
  — [Glorium Tech](https://gloriumtech.com/odoo-community-vs-enterprise/); [Packt Working with Odoo 10, ch.16](https://www.oreilly.com/library/view/working-with-odoo/9781786462688/ch16.html); [Cybrosys Odoo 20 Community vs Enterprise by department](https://www.cybrosys.com/blog/odoo-20-community-vs-enterprise-features-by-department)
- Community users rely on the Odoo Community Association (OCA) to fill accounting and payroll gaps. — [Glorium Tech](https://gloriumtech.com/odoo-community-vs-enterprise/)

**Odoo US and Canada fit**
- AvaTax works with Odoo Accounting, Invoicing, Sales, eCommerce and, where configured, POS (vendor page). — [Avalara Odoo integration](https://www.avalara.com/us/en/products/integrations/odoo.html)
- A March 2026 comparison rates Odoo's US localization "Strong US localization (EE)" and ERPNext's as "Community-maintained localizations". — [Velsof Odoo vs ERPNext](https://www.velsof.com/?p=2243)
- Odoo's Canada localization (l10n_ca):
  - It provides base accounting, reporting and check printing.
  - It has fiscal positions for provinces and territories, including ON, QC, SK, PEI, Nunavut and Yukon.
  - The docs point to AvaTax for location-based GST/HST/PST.
  — [Odoo 19 Canada fiscal localization](https://www.odoo.com/documentation/19.0/applications/finance/fiscal_localizations/canada.html)
- Odoo has no official Canadian payroll (no T4/ROE) in v18 or v19. — [Odoo forum: payroll localization v19 Canada](https://www.odoo.com/forum/help-1/payroll-localization-for-version-19-in-canada-288752)
- A third-party "Canadian GST/HST Compliance" module for Odoo 19 is listed at €49 per database per year. Its listing still contains placeholder text. — [Odoo Apps: flexigo_canadian_gst_hst_compliance_module](https://apps.odoo.com/apps/modules/18.0/flexigo_canadian_gst_hst_compliance_module)
- Odoo forum guidance says it is the client's responsibility to review tax rates with their accountant. — [Odoo forum: Canada tax](https://www.odoo.com/forum/help-1/re-canada-tax-233450)

**ERPNext US/Canada fit and QuickBooks**
- ERPNext has a documented built-in TaxJar integration. You configure API tokens in TaxJar Settings and add nexus states in TaxJar, and complete addresses with the correct state are required. — [ERPNext TaxJar integration docs](https://docs.frappe.io/erpnext/user/manual/en/taxjar_integration)
- A third-party vendor (ECOSIRE) sells build-to-order TaxJar and Avalara connectors for ERPNext v15/16. It quotes 2–4 weeks delivery and adds taxability mapping, nexus monitoring and exemption certificates. — [ECOSIRE ERPNext TaxJar connector](https://ecosire.com/apps/erpnext/erpnext-taxjar-connector); [ECOSIRE ERPNext Avalara](https://ecosire.com/de/apps/erpnext/erpnext-avalara-tax-engine)
- ERPNext's built-in QuickBooks Migrator was removed from develop on 2025-01-17 (PR #45240). Migration now uses Data Import, the Chart of Accounts Importer, opening invoices and journal entries. — [ERPNext QuickBooks Migrator docs](https://docs.frappe.io/erpnext/user/manual/en/quickbooks-migrator)
- Third-party QuickBooks connectors exist on the Frappe Cloud marketplace, and a community thread says there is no official connector. — [Frappe Cloud marketplace: quickbooks_connector](https://cloud.frappe.io/marketplace/apps/quickbooks_connector); [Frappe Cloud marketplace: quickbooks_master_sync](https://cloud.frappe.io/marketplace/apps/quickbooks_master_sync); [discuss.frappe.io connector thread](https://discuss.frappe.io/t/connector-for-quickbooks/145633)

**Talent pool**
- One roundup counts 3,812 Odoo partners and 62,413 references as of 2026-01-09, with the US having the most partners (250). Other blogs claim 3,800 to 16,000+ partners, so the figures conflict. — [Glorium Tech Odoo statistics](https://gloriumtech.com/odoo-statistics/); [ECOSIRE Odoo vs ERPNext 2026](https://ecosire.com/blog/odoo-vs-erpnext-deep-comparison-2026)
- ERPNext partner estimates range from about 200 to about 500. Odoo is estimated at about 7M to 16M users, against about 1M for ERPNext (vendor-affiliated sources). — [ECOSIRE comparison](https://ecosire.com/compare/odoo-vs-erpnext)

### Inferences
- **Fit for US/Canadian SMBs (5–50 staff) on a Community/open-source basis:**
  - **Odoo Community + OCA:** strongest breadth (CRM, sales, purchasing, inventory, MRP, accounting) and the largest North American talent pool. You must bolt on OCA bank-statement import or reconciliation, the OCA financial reports (account-financial-reporting), and an Avalara connector. The official AvaTax integration may depend on Enterprise modules; verify this.
  - **ERPNext:** a complete and coherent single-codebase ERP with everything open, including reports, and built-in TaxJar. It is weaker on North American partner availability and QuickBooks connectivity.
  - **Dolibarr:** good for micro-businesses (invoicing, basic stock, CRM) but shallow for manufacturing and multi-entity accounting.
  - **Tryton and iDempiere:** solid accounting and supply chain, but very small North American communities make hiring hard.
- **Payroll.** Neither Odoo nor ERPNext offers turnkey US or Canadian payroll in the sources found. Plan to integrate an external payroll provider such as Gusto, ADP or Wagepoint, posting summary journal entries into the ERP.
- **QuickBooks coexistence.** Many SMBs and their accountants will want to keep QuickBooks Online. A practical offer is "ERP ops (CRM, sales, purchasing, inventory) plus accounting either in-ERP or synced to QBO". This needs a QBO sync connector, which you must build or buy for both Odoo and ERPNext.
- **Sales tax.** The customer should hold the Avalara or TaxJar account and pay for it directly. That keeps you out of tax-liability exposure.

### Gaps
- The exact Odoo 18/19 feature split for accounting reports between Community and Enterprise was not verified on current official docs.
- Whether Odoo's official AvaTax connector requires Enterprise was not confirmed.
- Odoo-to-QuickBooks Online connectors (official or third-party) were not researched.
- Current OCA module coverage for v18/v19 (bank reconciliation, financial reports, US check printing) was not verified.
- ERPNext Canadian GST/HST support was not found.

## 3. Custom build vs extending open source

### Takeaway
No credible published effort benchmarks were found. Extending Odoo Community or ERPNext is far cheaper and safer than building accounting from scratch. Even mature ERPs leave localization gaps, such as Canadian payroll and tax-rate maintenance, which shows how large the compliance surface is.

### Cited Findings
- Odoo's Canadian localization requires province-specific fiscal positions, and tax rates "vary by province and territory". Odoo points to AvaTax for automation and to accountant review. — [Odoo 19 Canada localization](https://www.odoo.com/documentation/19.0/applications/finance/fiscal_localizations/canada.html); [Odoo forum: Canada tax](https://www.odoo.com/forum/help-1/re-canada-tax-233450)
- Odoo has no Canadian payroll in v18 or v19 despite years of development. — [Odoo forum](https://www.odoo.com/forum/help-1/payroll-localization-for-version-19-in-canada-288752)
- A 2026 comparison treats a custom-built headless CRM as a viable alternative to Twenty or EspoCRM, but only for the CRM. — [dev.to Twenty vs EspoCRM vs custom](https://dev.to/iurii_rogulia/best-headless-crm-in-2026-twenty-vs-espocrm-vs-custom-build-501c)
- Vendors report that custom modules drive migration cost. One project had 122 custom modules, 53 of them high-complexity and 26 needing JavaScript rewrites. — [OCA OpenUpgrade news](https://odoo-community.org/blog/news-updates-1/openupgrade-187); [Cybrosys Odoo 20 migration budget](https://www.cybrosys.com/blog/how-much-should-you-budget-for-an-odoo-20-migration)

### Inferences
These are unsourced estimates and should be validated with implementers.
- **Extending Odoo Community or ERPNext:**

  | Work item | Rough effort |
  |---|---|
  | Multi-tenant provisioning and backup pipeline | ~2–4 dev-weeks |
  | Per-vertical template (chart of accounts, taxes, workflows, reports) | ~2–6 weeks |
  | Per-customer onboarding (data migration from QBO or spreadsheets, configuration, training) | ~1–4 weeks |
  | API/tool layer for the existing bots | ~2–4 weeks |
  | Annual major-version upgrade, per customised module set | ~1–3 dev-weeks |

- **Custom CRM only:** about 2–4 months to reach basic parity (contacts, companies, deals, pipeline, activities, email logging). You still need an ERP or QuickBooks behind it.
- **Custom ERP with accounting, inventory and purchasing:** likely 12–24+ developer-months to reach credible SMB parity. The scope includes:
  - GL, AR/AP, bank reconciliation, CAD/USD multi-currency.
  - US sales tax plus GST/HST/PST/QST.
  - Period close and locks, audit trail.
  - FIFO/average inventory valuation, landed costs, POs, three-way match, financial statements.
- **Main risks of building your own ERP:**
  - Ledger-integrity bugs.
  - Tax miscalculation liability.
  - Accountant distrust.
  - Year-end and audit support.
  - Diverting a solo founder's time from the bots, which are the differentiator.
- **Recommendation:** extend, don't build. Keep custom modules few and thin, and put business logic in your own external services where possible. This keeps major-version upgrades cheap.

### Gaps
- No primary-source effort benchmarks for custom ERP or CRM builds, or for per-customer Odoo/ERPNext onboarding hours.

## 4. Multi-tenant hosting costs, backups and major-version upgrades

### Takeaway
- **ERPNext:** one bench can host many sites, each with its own database. Frappe Cloud starts at $5/site/month (shared) or $40/month for a dedicated server. ERPNext is cheaper to multi-tenant than Odoo.
- **Odoo:** Odoo.sh is priced per worker, per GB and per staging environment, and does not include the Enterprise licence. Self-hosting Odoo Community on Hetzner (from €5.49 shared or €36.99 dedicated-vCPU) or a Canadian-region cloud is the low-cost route.
- **Upgrades:** Odoo's official upgrade service does not cover Community. Community upgrades go through OCA OpenUpgrade, and custom modules are the main cost driver.

### Cited Findings
**Frappe Cloud and ERPNext multi-tenancy**
- Frappe Cloud pricing (fetched 2026-11-24):
  - Shared site plans start at $5/month and dedicated servers at $40/month.
  - Automated offsite backups are included.
  - It runs multi-cloud on Hetzner, AWS and OCI, but the region list was not shown.
  - Product Warranty covers bug fixes but excludes functional support.
  — [Frappe Cloud pricing](https://frappe.io/cloud/pricing)
- A Frappe bench hosts one or more sites, each with its own isolated database, and the apps are shared across sites. — [Frappe Customer Guide: architecture/isolation](https://docs.frappe.io/customer-guide/security/isolation-mechanisms); [discuss.frappe.io: multi ERPNext on one server](https://discuss.frappe.io/t/multi-erpnext-on-a-single-server/32812)
- Updating a bench updates all of its sites. Separate benches give per-customer upgrade control. — [discuss.frappe.io: multi ERPNext on one server](https://discuss.frappe.io/t/multi-erpnext-on-a-single-server/32812)
- Frappe Cloud sizing guidance:
  - An empty bench needs about 400 MB.
  - Bench memory is calculated as a 512 MB base, plus 150 MB per gunicorn worker, plus 240 MB per background worker.
  - The database working set (often the last year of data) should fit in database RAM.
  — [Frappe Cloud: choosing a server plan](https://docs.frappe.io/cloud/servers/guidelines-for-choosing-a-server-plan); [Frappe: how scaling works](https://docs.frappe.io/customer-guide/scalability/how-scaling-works)
- Community rules of thumb conflict:
  - One forum says one ERPNext system per 2 GB of RAM.
  - Another says a 32 GB / 4 CPU server fits about 3 heavy sites, or about 30 light ones.
  — [discuss.frappe.io: how many sites can my server handle](https://discuss.frappe.io/t/how-many-sites-can-my-server-handle-efficiently/142670); [discuss.frappe.io: 10 sites config](https://discuss.frappe.io/t/what-configuration-should-my-server-have-to-run-erpnext-with-say-10-sites/105004)

**Odoo hosting**
- Odoo.sh:
  - Workers are priced per worker (1–16 on shared hosting) and storage per GB (1–512 GB on shared), plus staging environments. A dedicated option exists.
  - Backups are kept on "3 backups servers in different locations".
  - Dollar amounts were blank on the page and regions were not listed.
  - "Hosting does not include the enterprise licence."
  — [Odoo.sh pricing](https://www.odoo.sh/pricing)
- Odoo Online hosting is free with storage unmetered up to 100 GB, but Odoo.sh, on-premise hosting and the External API require the Custom plan. — [Odoo pricing](https://www.odoo.com/pricing-plan)
- Odoo Enterprise prices (CAD, fetched 2026-11-24, garbled layout, so verify on the live page):

  | Plan | Billed yearly (first 12 months discounted) | Billed monthly |
  |---|---|---|
  | Standard | ~CAD 35.20/user/month (from CAD 44.00) | ~CAD 44.00 |
  | Custom | ~CAD 57.90/user/month (from CAD 73.00) | ~CAD 73.00 |

  — [Odoo pricing](https://www.odoo.com/pricing-plan)

**Infrastructure prices and Canadian regions**
- Hetzner Cloud (fetched 2026-11-24, excluding VAT):
  - Regular Performance shared VMs from €5.49/month.
  - Cost-Optimized shared VMs from €5.99/month, currently not available.
  - General Purpose dedicated vCPU from €36.99/month.
  - US locations are Ashburn and Hillsboro; there is no Canadian location.
  — [Hetzner Cloud](https://www.hetzner.com/cloud)
- Canadian regions by provider:

  | Provider | Canadian regions |
  |---|---|
  | AWS | ca-central-1 (Montreal), ca-west-1 (Calgary, fewer services) |
  | Google Cloud | Toronto, Montreal |
  | Azure | Canada Central (Toronto), Canada East (Quebec City) |
  | DigitalOcean | TOR1 only |

  — [dev.to: Data residency in Canada / ca-central-1](https://dev.to/jam-techcirkle/data-residency-in-canada-what-ca-central-1-actually-costs-you-3aop); [Google Canada blog](https://blog.google/intl/en-ca/products/supporting-businesses/advancing-sovereignty-choice-and-security-in-the-cloud-for-our-customers-in-canada/); [Findstack Canada VPS](https://findstack.com/resources/best-vps-hosting-canada); [d-central Canada cloud residency index](https://d-central.tech/data/canada-ai-cloud-residency/)

**Upgrades**
- OCA OpenUpgrade migrates Community databases between versions. Migration scripts must exist for every installed module across every intermediate version. Custom modules, data corrections and testing are extra work. — [OCA OpenUpgrade news](https://odoo-community.org/blog/news-updates-1/openupgrade-187)
- Odoo's upgrade platform is reported as unavailable for Community. — [Solvve: Odoo migration tools](https://solvve.odoo.com/blog/articles-4/odoo-migration-tools-methods-best-practices-65); [Odoo docs: upgrade a customized database](https://www.odoo.com/documentation/master/developer/howtos/upgrade_custom_db.html)
- Vendor estimates put customisation migration at about 20–30% of upgrade cost and data migration at about 25–35%. These are marketing figures. — [dev.to: Odoo migration cost breakdown](https://dev.to/aspire-softserv/what-does-odoo-migration-really-cost-a-transparent-pricing-breakdown-for-2025-48fj); [Ksolves Odoo migration cost](https://www.ksolves.com/blog/odoo/odoo-migration-cost-key-factors-affecting-budget)
- Reports of a 25% "legacy surcharge" for Odoo 16 and earlier from March 2026 were found but not verified against an Odoo source. — [search result: Cybrosys budgeting article](https://www.cybrosys.com/blog/how-much-should-you-budget-for-an-odoo-20-migration)

### Inferences
- **Tenancy model:** one database per customer. Use Odoo multi-database with a dbfilter by hostname, or one Frappe site per customer. Group tenants that share a release cycle on one bench or Odoo install, and give large or heavily customised tenants their own VM. This keeps restores, offboarding, data export and Canadian residency per customer simple.
- **Density (unsourced; load-test before relying on it):**
  - A 4 vCPU / 16 GB VM likely handles about 8–20 small tenants (under 10 users, light inventory).
  - That works out to roughly $3–10 of infrastructure per small tenant per month on Hetzner or DigitalOcean.
  - Expect about 1.5–2.5× that on AWS ca-central-1 with managed Postgres.
- **Backups:**
  - Nightly per-tenant pg_dump plus filestore sync to object storage in a second region, such as a second Canadian region for Canadian tenants.
  - Point-in-time WAL archiving for larger tenants.
  - Retain 30 daily and 12 monthly copies, and run a quarterly restore drill.
- **Upgrade cadence:**
  - Pin tenants to one major version and upgrade every 1–2 major versions rather than yearly.
  - Keep custom code in few, well-tested modules.
  - Budget about 1–3 dev-weeks per upgrade cycle per module set, plus per-tenant test time.
  - ERPNext's bench update/migrate is simpler operationally, but a bench-wide update affects every site on it.

### Gaps
- Odoo.sh dollar prices, the Frappe Cloud per-plan specs and region list, Hetzner and DigitalOcean per-plan specs, and AWS ca-central-1 instance and RDS prices were not obtained.
- No independent per-tenant density benchmarks for Odoo were found.

## 5. Integration tooling for connecting the existing bots to the ERP/CRM

### Takeaway
- **n8n:** its Sustainable Use License does not allow providing n8n to others for a fee. Use it only for your own internal ops, or buy a commercial licence.
- **Customer-facing integration:** build your own authenticated API/tool gateway over Odoo's RPC API or ERPNext's REST API.
- **MCP:** several MIT-licensed Odoo MCP servers exist but lack built-in HTTP authentication. No ERPNext MCP server surfaced.

### Cited Findings
- The n8n Sustainable Use License says:
  - "You may use or modify the software only for your own internal business purposes or for non-commercial or personal use."
  - "You may distribute the software or provide it to others only if you do so free of charge for non-commercial purposes."
  - `.ee` files require an n8n Enterprise License.
  - Violations terminate the licence unless cured within 30 days of notice.
  — [n8n LICENSE.md](https://github.com/n8n-io/n8n/blob/master/LICENSE.md)
- Odoo MCP servers:
  - ivnvxd/mcp-server-odoo: MIT, about 130 stars, needs Odoo 18.0+ and an Odoo API key. Its HTTP transport has no built-in authentication.
  - deeprunnerai/odoo-mcp-server: TypeScript, covers Inventory, CRM, Sales, Manufacturing and Purchases.
  - tuanle96/mcp-odoo: targets Odoo 16+.
  - lm_mcp_server: an Odoo Apps module for v18.
  — [PyPI mcp-server-odoo](https://pypi.org/project/mcp-server-odoo/); [mcpservers.org ivnvxd](https://mcpservers.org/ru/servers/ivnvxd/mcp-server-odoo); [GitHub deeprunnerai/odoo-mcp-server](https://github.com/deeprunnerai/odoo-mcp-server); [ecosyste.ms tuanle96/mcp-odoo](https://awesome.ecosyste.ms/projects/github.com%2Ftuanle96%2Fmcp-odoo); [Odoo Apps lm_mcp_server](https://apps.odoo.com/apps/modules/18.0/lm_mcp_server)
- On Odoo Online/Enterprise, the External API is listed as a Custom-plan feature. — [Odoo pricing](https://www.odoo.com/pricing-plan)
- No ERPNext MCP server appeared in results. An ERP MCP roundup covers Odoo, Dynamics 365, NetSuite and SAP. — [dev.to ERP MCP servers roundup](https://dev.to/grove_chatforest/erp-business-management-mcp-servers-odoo-dynamics-365-netsuite-sap-and-more-5f41)

### Inferences
- **n8n is a poor core integration layer for a paid multi-tenant product.** Hosting n8n and charging customers for workflows built on it, or exposing its editor to them, is outside the Sustainable Use License without n8n's commercial (Embed) licence. Internal-only use for your own ops is allowed. Get written confirmation from n8n before running customer-data workflows on it.
- **Recommended pattern:** your own small "tool gateway" service.
  - Typed endpoints such as `get_customer_balance`, `list_open_invoices`, `create_rfq`, `log_payment_promise`, `create_lead`, `book_activity`.
  - Calls Odoo's JSON-RPC/XML-RPC with per-tenant API keys (self-hosted Community has no plan gate), or ERPNext's REST API with token auth.
  - Enforces RBAC, rate limits and an audit log of every bot-initiated write.
  - Exposes the same tools as MCP and as HTTPS webhooks for the existing bots.
- **Event flow from the ERP to the bots:**
  - Odoo: automated actions with webhooks, or a queue (OCA queue_job).
  - ERPNext: webhooks and background jobs.
  - Durable multi-step flows such as dunning sequences can run in a job queue or Temporal (licence and pricing not verified here) rather than n8n.
- **Make and Zapier** are per-account SaaS with their own pricing and data-residency exposure. Use them only if the customer owns the account.

### Gaps
- n8n Embed/Enterprise pricing and terms were not obtained, and the n8n docs licence FAQ page returned 404.
- Temporal's licence and Temporal Cloud pricing, and Make and Zapier pricing, were not fetched.
- Twenty, EspoCRM and SuiteCRM API and webhook capabilities were not researched in detail.

## 6. Security and reliability: SOC 2, Canadian data residency, backups

### Takeaway
- **SOC 2:** budget about USD 15k–60k all-in and 6–15 months for a first Type II, using a compliance-automation platform and a boutique auditor.
- **Canadian residency:** mostly a contractual or procurement requirement, not a universal statute. Québec Law 25 requires a transfer impact assessment. Host Canadian tenants' ERP databases and backups in a Canadian region, and note that US-headquartered clouds remain exposed to the CLOUD Act.

### Cited Findings
- SOC 2 cost and timeline:
  - Drata puts first-year all-in cost at about $25k for a small startup.
  - Probo (2026) breaks a sub-15-person startup down to about $15k: about $4k for the platform, $6k for people and $5k for a Type 2 audit with a smaller firm.
  - Startup Type II audit fees run about $8k–$50k+. One source gives $12k–$25k for a 6-month window. Boutique auditors charge $10k–15k against $20k–30k at established firms.
  - Platforms cost about $7k–$25k/year. Strac's bundle is $8,995/year including an audit.
  - The observation window is typically 6 months, and the full process takes 6–15 months.
  — [Drata SOC 2 cost](https://drata.com/learn/soc-2/cost); [Probo SOC 2 cost](https://www.probo.com/blog/2025-03-04-what-is-soc2-cost); [soc2auditors.org Type 2 cost](https://soc2auditors.org/insights/soc-2-type-2-audit-cost/); [Strac SOC 2 cost](https://www.strac.io/blog/soc-2-cost); [beancount.io SOC 2 Type II guide (2026-05-11)](https://beancount.io/blog/2026/05/11/soc-2-type-ii-saas-startups-trust-services-criteria-audit-cost-six-month-observation-window-first-examination-guide)
- Residency law:
  - No single Canadian statute imposes universal data residency; requirements come mainly from contracts and procurement.
  - A US-hosted provider can be PIPEDA-compliant with a DPA and comparable-protection commitments.
  - Residency does not remove CLOUD Act exposure for US-headquartered providers.
  - Québec Law 25 requires a TIA.
  — [d-central Canada cloud residency index](https://d-central.tech/data/canada-ai-cloud-residency/); [Peony: Data Room Canada (PIPEDA)](https://www.peony.ink/blog/data-room-canada)
- Canadian region options are listed in section 4. — [d-central](https://d-central.tech/data/canada-ai-cloud-residency/); [Findstack](https://findstack.com/resources/best-vps-hosting-canada)
- Managed backups: Odoo.sh keeps 3 backup servers in different locations, and Frappe Cloud includes automated offsite backups. — [Odoo.sh pricing](https://www.odoo.sh/pricing); [Frappe Cloud pricing](https://frappe.io/cloud/pricing)
- Self-hosting Odoo Enterprise requires giving Odoo SA access to verify licence validity, which is relevant to security reviews. — [Odoo Enterprise Agreement §6.1](https://www.odoo.com/documentation/19.0/legal/terms/enterprise.html)

### Inferences
- **SOC 2 sequencing:**
  - Start with a security page, a CAIQ-lite questionnaire and documented policies.
  - Begin Type II when a deal requires it or once you have about 5–10 customers.
  - Keep scope narrow: Security criterion only, the production ERP hosting environment, and a minimal sub-processor list.
- **Minimum controls:**
  - SSO and MFA on all admin, SSH and cloud consoles.
  - Per-tenant database credentials.
  - Encryption at rest and in transit.
  - Infrastructure as code for tenant provisioning.
  - Centralized logs.
  - Audit trail on bot-initiated ERP writes.
  - Quarterly restore tests.
  - Documented offboarding: export, then deletion within N days.
- **Canada tier:**
  - Host the ERP database, filestore and backups in AWS ca-central-1 plus ca-west-1, GCP Toronto plus Montreal, or DigitalOcean TOR1 (single region, so back up to another Canadian provider or region).
  - Hetzner is suitable only for US tenants.
  - Disclose any US sub-processors, including the bots' AI vendors.

### Gaps
- Vanta and Drata list prices were not confirmed.
- OVH Canada (Beauharnois) pricing and region details were not found.
- No source quantifies the price premium of Canadian cloud regions over US regions.

## 7. Reference architecture and per-customer COGS (ERP/CRM layer only)

### Takeaway
- **Recommended stack:**
  - Odoo Community 18/19 plus OCA modules (the alternative is ERPNext) with the built-in CRM.
  - Self-hosted, one database per tenant, on Hetzner/DigitalOcean for US tenants and a Canadian cloud region for Canadian tenants.
  - Your own authenticated API/tool gateway for the existing bots.
- **Estimated ERP/CRM COGS:** about USD 15–35/month for a small customer, 45–90 for a medium one and 150–250 for a large one, excluding labour, bots and SOC 2 amortisation.
- **Odoo Enterprise would add about CAD 35–73/user/month,** which outweighs every other ERP COGS item. That is the main reason to build on Community or ERPNext.

### Cited Findings
These are the inputs; all are cited above.

| Input | Price | Source |
|---|---|---|
| Frappe Cloud | from $5/site/month shared; $40/month dedicated | [Frappe Cloud](https://frappe.io/cloud/pricing) |
| Hetzner | from €5.49 shared; €36.99 dedicated vCPU | [Hetzner](https://www.hetzner.com/cloud) |
| Odoo Enterprise Standard | ~CAD 35.20–44/user/month | [Odoo pricing](https://www.odoo.com/pricing-plan) |
| Odoo Enterprise Custom | ~CAD 57.90–73/user/month | [Odoo pricing](https://www.odoo.com/pricing-plan) |
| Third-party Canadian GST/HST module example | €49/database/year | [Odoo Apps Flexigo](https://apps.odoo.com/apps/modules/18.0/flexigo_canadian_gst_hst_compliance_module) |
| SOC 2 first-year all-in | ~$15k–60k | [Drata](https://drata.com/learn/soc-2/cost); [Probo](https://www.probo.com/blog/2025-03-04-what-is-soc2-cost) |

### Inferences
**Reference architecture (ERP/CRM side)**
1. **Core:** Odoo Community 18/19.
   - Apps: CRM, Sales, Purchase, Inventory, MRP (if needed) and Invoicing/Accounting.
   - OCA additions: account-financial-reporting, bank statement import and reconciliation, and queue_job.
   - Your private modules: vertical templates and bot hooks.
   - Use a debranding module or your own theme for white-label, and keep the LGPL notices.
   - Alternative core: ERPNext v15/16 on Frappe, which has everything open including reports, built-in TaxJar and simpler bench multi-tenancy, but a thinner North American ecosystem.
2. **Tax and accounting edges:**
   - Avalara (Odoo) or TaxJar (ERPNext), with the customer holding the account.
   - An external payroll provider with a journal-entry sync.
   - Optional QuickBooks Online sync for customers whose accountant insists on it, built or bought.
3. **Hosting:**
   - Ansible or Terraform-provisioned VMs, one database per tenant, Postgres per VM (or managed Postgres in Canada).
   - Nightly per-tenant backups to a second-region object store.
   - Staging copy per tenant before upgrades.
4. **Integration:** a tool gateway (REST plus MCP) with per-tenant keys, RBAC and an audit log, plus ERP webhooks and queue jobs out to the existing bots. No resold n8n.
5. **Security:** SSO/MFA, secrets vault, centralized logs, status page, and a SOC 2 platform from year 1–2.

**Monthly ERP/CRM COGS per customer** (USD, estimates)

| Line item | Small (≤5 users, single company, light inventory) | Medium (~15 users, inventory + purchasing, some MRP) | Large (~40 users, multi-company, heavy inventory/MRP) |
|---|---|---|---|
| Compute (share of a 4 vCPU/16 GB VM → dedicated VM) | $5–15 | $20–45 | $80–150 (own VM, or dedicated vCPU plus managed DB) |
| Backup storage and second-region copy | $1–3 | $3–8 | $10–25 |
| Monitoring, logging, email-relay share | $5–10 | $10–20 | $20–40 |
| Third-party paid modules (OPL-1 apps, e.g. €49/db/yr), amortised | $0–5 | $5–15 | $10–30 |
| **ERP/CRM infra COGS** | **~$15–35** | **~$45–90** | **~$150–250** |
| Canadian-region uplift (AWS ca-central-1 / managed Postgres vs Hetzner) | +$5–15 | +$20–50 | +$75–150 |
| Frappe Cloud alternative (managed, no ops) | ~$5–25/site | ~$25–60 | ~$40–150+ (dedicated server) |
| If Odoo Enterprise is required (customer-held, CAD/user/month) | +CAD ~175–365 | +CAD ~530–1,095 | +CAD ~1,410–2,920 |
| SOC 2 amortised (~$25k/yr ÷ 20 customers) | ~$100 | ~$100 | ~$100 |
| Sales-tax engine (Avalara/TaxJar) | customer-paid | customer-paid | customer-paid |

- **Infrastructure is cheap; labour is the real cost.** Onboarding, customisation, support and major-version upgrades (section 3) will dominate true per-customer cost. For a solo founder they will cap capacity at perhaps 10–25 managed ERP customers.
- **Pricing implication:** charge separately for onboarding and migration (fixed fee), a monthly managed-ERP fee per company plus per user, and an annual upgrade or maintenance component.
- **Decision rule:**
  - Pick Odoo Community if North American partner availability, module breadth and the Avalara path matter most.
  - Pick ERPNext if you want everything open (no Community/Enterprise split), cheaper multi-tenancy and built-in TaxJar, and you accept a smaller North American talent pool and building a QuickBooks sync.
  - Avoid Odoo Enterprise inside the bundle unless you become a partner and pass the subscription through.
  - Avoid standalone AGPL CRMs unless a customer needs CRM-only.

### Gaps
- All sizing and COGS figures are estimates and need a pilot load test.
- There is no sourced data on support or onboarding hours per managed Odoo/ERPNext customer.
- AWS ca-central-1 and DigitalOcean TOR1 list prices were not fetched to firm up the Canadian uplift.
