-- Generated from demo.json by pnpm codegen.
BEGIN;
SET LOCAL standard_conforming_strings = on;
CREATE SCHEMA IF NOT EXISTS demo_fixture;
CREATE TABLE IF NOT EXISTS demo_fixture.workspace (tenant_id text NOT NULL, id text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY (tenant_id, id));
TRUNCATE demo_fixture.workspace;
INSERT INTO demo_fixture.workspace (tenant_id, id, payload) VALUES
  ('tenant-rivetquay', 'tenant-rivetquay', '{"id":"tenant-rivetquay","name":"Rivetquay Industrial Supply","city":"Toronto"}'::jsonb),
  ('tenant-spoolharbour', 'tenant-spoolharbour', '{"id":"tenant-spoolharbour","name":"Spoolharbour Test Workspace","city":"Toronto"}'::jsonb);
CREATE TABLE IF NOT EXISTS demo_fixture.actor_grant (tenant_id text NOT NULL, id text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY (tenant_id, id));
TRUNCATE demo_fixture.actor_grant;
INSERT INTO demo_fixture.actor_grant (tenant_id, id, payload) VALUES
  ('tenant-rivetquay', 'actor-operator', '{"tenantId":"tenant-rivetquay","actor":{"id":"actor-operator","kind":"person"},"role":"operator"}'::jsonb),
  ('tenant-rivetquay', 'actor-approver', '{"tenantId":"tenant-rivetquay","actor":{"id":"actor-approver","kind":"person"},"role":"approver"}'::jsonb),
  ('tenant-rivetquay', 'actor-reader', '{"tenantId":"tenant-rivetquay","actor":{"id":"actor-reader","kind":"person"},"role":"reader"}'::jsonb),
  ('tenant-rivetquay', 'actor-worker', '{"tenantId":"tenant-rivetquay","actor":{"id":"actor-worker","kind":"service"},"role":"operator"}'::jsonb),
  ('tenant-spoolharbour', 'actor-isolation', '{"tenantId":"tenant-spoolharbour","actor":{"id":"actor-isolation","kind":"person"},"role":"operator"}'::jsonb);
CREATE TABLE IF NOT EXISTS demo_fixture.customer (tenant_id text NOT NULL, id text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY (tenant_id, id));
TRUNCATE demo_fixture.customer;
INSERT INTO demo_fixture.customer (tenant_id, id, payload) VALUES
  ('tenant-rivetquay', 'cust-001', '{"id":"cust-001","tenantId":"tenant-rivetquay","version":1,"name":"Fablegirt Fabrication","email":"orders1@rivetquay.example","phone":"+14165550101","lastOrderOn":"2026-11-20","outreachAllowed":true}'::jsonb),
  ('tenant-rivetquay', 'cust-002', '{"id":"cust-002","tenantId":"tenant-rivetquay","version":1,"name":"Coppernook Assembly","email":"orders2@rivetquay.example","phone":"+14165550102","lastOrderOn":"2026-11-19","outreachAllowed":true}'::jsonb),
  ('tenant-rivetquay', 'cust-003', '{"id":"cust-003","tenantId":"tenant-rivetquay","version":1,"name":"Brassfen Machinery","email":"orders3@rivetquay.example","phone":"+14165550103","lastOrderOn":"2026-11-18","outreachAllowed":true}'::jsonb),
  ('tenant-rivetquay', 'cust-004', '{"id":"cust-004","tenantId":"tenant-rivetquay","version":1,"name":"Kettleweld Tooling","email":"orders4@rivetquay.example","phone":"+14165550104","lastOrderOn":"2026-11-17","outreachAllowed":true}'::jsonb),
  ('tenant-rivetquay', 'cust-005', '{"id":"cust-005","tenantId":"tenant-rivetquay","version":1,"name":"Tinweft Enclosures","email":"orders5@rivetquay.example","phone":"+14165550105","lastOrderOn":"2026-11-16","outreachAllowed":true}'::jsonb),
  ('tenant-rivetquay', 'cust-006', '{"id":"cust-006","tenantId":"tenant-rivetquay","version":1,"name":"Gasketmere Controls","email":"orders6@rivetquay.example","phone":"+14165550106","lastOrderOn":"2026-11-15","outreachAllowed":true}'::jsonb),
  ('tenant-rivetquay', 'cust-007', '{"id":"cust-007","tenantId":"tenant-rivetquay","version":1,"name":"Spindlefern Repair","email":"orders7@rivetquay.example","phone":"+14165550107","lastOrderOn":"2026-11-14","outreachAllowed":true}'::jsonb),
  ('tenant-rivetquay', 'cust-008', '{"id":"cust-008","tenantId":"tenant-rivetquay","version":1,"name":"Boltmarsh Works","email":"orders8@rivetquay.example","phone":"+14165550108","lastOrderOn":"2026-03-16","outreachAllowed":true}'::jsonb),
  ('tenant-rivetquay', 'cust-009', '{"id":"cust-009","tenantId":"tenant-rivetquay","version":1,"name":"Clamporchard Mechanical","email":"orders9@rivetquay.example","phone":"+14165550109","lastOrderOn":"2026-03-16","outreachAllowed":true}'::jsonb),
  ('tenant-rivetquay', 'cust-010', '{"id":"cust-010","tenantId":"tenant-rivetquay","version":1,"name":"Sprocketvale Lab","email":"orders10@rivetquay.example","phone":"+14165550110","lastOrderOn":"2026-03-16","outreachAllowed":false}'::jsonb),
  ('tenant-spoolharbour', 'cust-isolation', '{"id":"cust-isolation","tenantId":"tenant-spoolharbour","version":1,"name":"Fictitious Seal Loom","email":"isolation@spoolharbour.example","phone":"+14165550199","lastOrderOn":"2026-11-20","outreachAllowed":false}'::jsonb);
CREATE TABLE IF NOT EXISTS demo_fixture.sku (tenant_id text NOT NULL, id text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY (tenant_id, id));
TRUNCATE demo_fixture.sku;
INSERT INTO demo_fixture.sku (tenant_id, id, payload) VALUES
  ('tenant-rivetquay', 'sku-001', '{"id":"sku-001","tenantId":"tenant-rivetquay","name":"Nitrile gloves","onHand":5}'::jsonb),
  ('tenant-rivetquay', 'sku-002', '{"id":"sku-002","tenantId":"tenant-rivetquay","name":"Face shield","onHand":27}'::jsonb),
  ('tenant-rivetquay', 'sku-003', '{"id":"sku-003","tenantId":"tenant-rivetquay","name":"Foam earplugs","onHand":34}'::jsonb),
  ('tenant-rivetquay', 'sku-004', '{"id":"sku-004","tenantId":"tenant-rivetquay","name":"Safety goggles","onHand":41}'::jsonb),
  ('tenant-rivetquay', 'sku-005', '{"id":"sku-005","tenantId":"tenant-rivetquay","name":"Cut-resistant gloves","onHand":48}'::jsonb),
  ('tenant-rivetquay', 'sku-006', '{"id":"sku-006","tenantId":"tenant-rivetquay","name":"Hex bolts M8","onHand":55}'::jsonb),
  ('tenant-rivetquay', 'sku-007', '{"id":"sku-007","tenantId":"tenant-rivetquay","name":"Hex bolts M10","onHand":62}'::jsonb),
  ('tenant-rivetquay', 'sku-008', '{"id":"sku-008","tenantId":"tenant-rivetquay","name":"Lock nuts M8","onHand":69}'::jsonb),
  ('tenant-rivetquay', 'sku-009', '{"id":"sku-009","tenantId":"tenant-rivetquay","name":"Flat washers M10","onHand":76}'::jsonb),
  ('tenant-rivetquay', 'sku-010', '{"id":"sku-010","tenantId":"tenant-rivetquay","name":"Threadlocker","onHand":83}'::jsonb),
  ('tenant-rivetquay', 'sku-011', '{"id":"sku-011","tenantId":"tenant-rivetquay","name":"Hose clamps","onHand":90}'::jsonb),
  ('tenant-rivetquay', 'sku-012', '{"id":"sku-012","tenantId":"tenant-rivetquay","name":"Air hose","onHand":97}'::jsonb),
  ('tenant-rivetquay', 'sku-013', '{"id":"sku-013","tenantId":"tenant-rivetquay","name":"Brass coupling","onHand":104}'::jsonb),
  ('tenant-rivetquay', 'sku-014', '{"id":"sku-014","tenantId":"tenant-rivetquay","name":"Pressure gauge","onHand":111}'::jsonb),
  ('tenant-rivetquay', 'sku-015', '{"id":"sku-015","tenantId":"tenant-rivetquay","name":"Nylon tubing","onHand":118}'::jsonb),
  ('tenant-rivetquay', 'sku-016', '{"id":"sku-016","tenantId":"tenant-rivetquay","name":"O-ring kit","onHand":125}'::jsonb),
  ('tenant-rivetquay', 'sku-017', '{"id":"sku-017","tenantId":"tenant-rivetquay","name":"Filter cartridge","onHand":132}'::jsonb),
  ('tenant-rivetquay', 'sku-018', '{"id":"sku-018","tenantId":"tenant-rivetquay","name":"Bearing grease","onHand":139}'::jsonb),
  ('tenant-rivetquay', 'sku-019', '{"id":"sku-019","tenantId":"tenant-rivetquay","name":"Utility blade","onHand":146}'::jsonb),
  ('tenant-rivetquay', 'sku-020', '{"id":"sku-020","tenantId":"tenant-rivetquay","name":"Deburring tool","onHand":153}'::jsonb),
  ('tenant-rivetquay', 'sku-021', '{"id":"sku-021","tenantId":"tenant-rivetquay","name":"Steel ruler","onHand":160}'::jsonb),
  ('tenant-rivetquay', 'sku-022', '{"id":"sku-022","tenantId":"tenant-rivetquay","name":"Torque wrench","onHand":167}'::jsonb),
  ('tenant-rivetquay', 'sku-023', '{"id":"sku-023","tenantId":"tenant-rivetquay","name":"Shop towels","onHand":174}'::jsonb),
  ('tenant-rivetquay', 'sku-024', '{"id":"sku-024","tenantId":"tenant-rivetquay","name":"Absorbent pads","onHand":181}'::jsonb),
  ('tenant-rivetquay', 'sku-025', '{"id":"sku-025","tenantId":"tenant-rivetquay","name":"Parts bins","onHand":188}'::jsonb),
  ('tenant-spoolharbour', 'sku-isolation', '{"id":"sku-isolation","tenantId":"tenant-spoolharbour","name":"Test gasket","onHand":2}'::jsonb);
CREATE TABLE IF NOT EXISTS demo_fixture.vendor (tenant_id text NOT NULL, id text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY (tenant_id, id));
TRUNCATE demo_fixture.vendor;
INSERT INTO demo_fixture.vendor (tenant_id, id, payload) VALUES
  ('tenant-rivetquay', 'vendor-001', '{"id":"vendor-001","tenantId":"tenant-rivetquay","name":"Quillflange Fasteners"}'::jsonb),
  ('tenant-rivetquay', 'vendor-002', '{"id":"vendor-002","tenantId":"tenant-rivetquay","name":"Gritburrow Safety Goods"}'::jsonb),
  ('tenant-rivetquay', 'vendor-003', '{"id":"vendor-003","tenantId":"tenant-rivetquay","name":"Sinterwharf Fluid Parts"}'::jsonb);
CREATE TABLE IF NOT EXISTS demo_fixture.sales_order (tenant_id text NOT NULL, id text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY (tenant_id, id));
TRUNCATE demo_fixture.sales_order;
INSERT INTO demo_fixture.sales_order (tenant_id, id, payload) VALUES
  ('tenant-rivetquay', 'ord-001', '{"id":"ord-001","tenantId":"tenant-rivetquay","version":1,"customerId":"cust-001","placedOn":"2026-11-20","status":"fulfilled","totalCents":48250,"currency":"CAD","lines":[{"skuId":"sku-001","quantity":2}],"signals":[]}'::jsonb),
  ('tenant-rivetquay', 'ord-002', '{"id":"ord-002","tenantId":"tenant-rivetquay","version":1,"customerId":"cust-002","placedOn":"2026-11-19","status":"fulfilled","totalCents":67300,"currency":"CAD","lines":[{"skuId":"sku-006","quantity":3}],"signals":[]}'::jsonb),
  ('tenant-rivetquay', 'ord-003', '{"id":"ord-003","tenantId":"tenant-rivetquay","version":1,"customerId":"cust-003","placedOn":"2026-11-18","status":"held","totalCents":202500,"currency":"CAD","lines":[{"skuId":"sku-007","quantity":4}],"signals":["rush_request","unusual_order_value"]}'::jsonb),
  ('tenant-rivetquay', 'ord-004', '{"id":"ord-004","tenantId":"tenant-rivetquay","version":1,"customerId":"cust-004","placedOn":"2026-11-17","status":"held","totalCents":489000,"currency":"CAD","lines":[{"skuId":"sku-004","quantity":5}],"signals":["unusual_order_value","delivery_address_changed"]}'::jsonb),
  ('tenant-rivetquay', 'ord-005', '{"id":"ord-005","tenantId":"tenant-rivetquay","version":1,"customerId":"cust-005","placedOn":"2026-11-16","status":"open","totalCents":9500,"currency":"CAD","lines":[{"skuId":"sku-017","quantity":6}],"signals":[]}'::jsonb),
  ('tenant-rivetquay', 'ord-006', '{"id":"ord-006","tenantId":"tenant-rivetquay","version":1,"customerId":"cust-006","placedOn":"2026-11-15","status":"fulfilled","totalCents":15200,"currency":"CAD","lines":[{"skuId":"sku-021","quantity":7}],"signals":[]}'::jsonb),
  ('tenant-rivetquay', 'ord-007', '{"id":"ord-007","tenantId":"tenant-rivetquay","version":1,"customerId":"cust-007","placedOn":"2026-11-14","status":"fulfilled","totalCents":9200,"currency":"CAD","lines":[{"skuId":"sku-020","quantity":8}],"signals":[]}'::jsonb),
  ('tenant-rivetquay', 'ord-008', '{"id":"ord-008","tenantId":"tenant-rivetquay","version":1,"customerId":"cust-008","placedOn":"2026-03-16","status":"fulfilled","totalCents":45199,"currency":"CAD","lines":[{"skuId":"sku-013","quantity":9}],"signals":[]}'::jsonb),
  ('tenant-rivetquay', 'ord-009', '{"id":"ord-009","tenantId":"tenant-rivetquay","version":1,"customerId":"cust-009","placedOn":"2026-03-16","status":"fulfilled","totalCents":23998,"currency":"CAD","lines":[{"skuId":"sku-016","quantity":10}],"signals":[]}'::jsonb),
  ('tenant-rivetquay', 'ord-010', '{"id":"ord-010","tenantId":"tenant-rivetquay","version":1,"customerId":"cust-010","placedOn":"2026-03-16","status":"fulfilled","totalCents":12600,"currency":"CAD","lines":[{"skuId":"sku-018","quantity":11}],"signals":[]}'::jsonb),
  ('tenant-spoolharbour', 'ord-isolation', '{"id":"ord-isolation","tenantId":"tenant-spoolharbour","version":1,"customerId":"cust-isolation","placedOn":"2026-11-20","status":"open","totalCents":2500,"currency":"CAD","lines":[{"skuId":"sku-isolation","quantity":1}],"signals":[]}'::jsonb);
CREATE TABLE IF NOT EXISTS demo_fixture.invoice (tenant_id text NOT NULL, id text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY (tenant_id, id));
TRUNCATE demo_fixture.invoice;
INSERT INTO demo_fixture.invoice (tenant_id, id, payload) VALUES
  ('tenant-rivetquay', 'inv-001', '{"id":"inv-001","tenantId":"tenant-rivetquay","version":1,"customerId":"cust-002","orderId":"ord-002","dueOn":"2026-11-22","balanceCents":67300,"currency":"CAD","status":"overdue"}'::jsonb),
  ('tenant-rivetquay', 'inv-002', '{"id":"inv-002","tenantId":"tenant-rivetquay","version":1,"customerId":"cust-008","orderId":"ord-008","dueOn":"2026-04-16","balanceCents":45199,"currency":"CAD","status":"overdue"}'::jsonb),
  ('tenant-rivetquay', 'inv-003', '{"id":"inv-003","tenantId":"tenant-rivetquay","version":1,"customerId":"cust-009","orderId":"ord-009","dueOn":"2026-04-16","balanceCents":23998,"currency":"CAD","status":"disputed"}'::jsonb),
  ('tenant-rivetquay', 'inv-004', '{"id":"inv-004","tenantId":"tenant-rivetquay","version":1,"customerId":"cust-010","orderId":"ord-010","dueOn":"2026-04-16","balanceCents":12600,"currency":"CAD","status":"overdue"}'::jsonb);
CREATE TABLE IF NOT EXISTS demo_fixture.purchase_request (tenant_id text NOT NULL, id text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY (tenant_id, id));
TRUNCATE demo_fixture.purchase_request;
INSERT INTO demo_fixture.purchase_request (tenant_id, id, payload) VALUES
  ('tenant-rivetquay', 'pr-001', '{"id":"pr-001","tenantId":"tenant-rivetquay","version":1,"vendorId":"vendor-002","costCentre":"stock-toronto","currency":"CAD","lines":[{"skuId":"sku-001","quantity":60,"unitCostCents":420}]}'::jsonb);
CREATE TABLE IF NOT EXISTS demo_fixture.entitlement (tenant_id text NOT NULL, id text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY (tenant_id, id));
TRUNCATE demo_fixture.entitlement;
INSERT INTO demo_fixture.entitlement (tenant_id, id, payload) VALUES
  ('tenant-rivetquay', 'records:actions', '{"tenantId":"tenant-rivetquay","flag":{"module":"records","enabled":true},"unit":"actions","allowance":40,"windowStart":"2026-11-01T00:00:00Z","windowEnd":"2026-12-01T00:00:00Z"}'::jsonb),
  ('tenant-rivetquay', 'procurement:actions', '{"tenantId":"tenant-rivetquay","flag":{"module":"procurement","enabled":true},"unit":"actions","allowance":40,"windowStart":"2026-11-01T00:00:00Z","windowEnd":"2026-12-01T00:00:00Z"}'::jsonb),
  ('tenant-rivetquay', 'collections:actions', '{"tenantId":"tenant-rivetquay","flag":{"module":"collections","enabled":true},"unit":"actions","allowance":40,"windowStart":"2026-11-01T00:00:00Z","windowEnd":"2026-12-01T00:00:00Z"}'::jsonb),
  ('tenant-rivetquay', 'workflows:actions', '{"tenantId":"tenant-rivetquay","flag":{"module":"workflows","enabled":true},"unit":"actions","allowance":40,"windowStart":"2026-11-01T00:00:00Z","windowEnd":"2026-12-01T00:00:00Z"}'::jsonb),
  ('tenant-rivetquay', 'insights:actions', '{"tenantId":"tenant-rivetquay","flag":{"module":"insights","enabled":true},"unit":"actions","allowance":40,"windowStart":"2026-11-01T00:00:00Z","windowEnd":"2026-12-01T00:00:00Z"}'::jsonb),
  ('tenant-rivetquay', 'ai:actions', '{"tenantId":"tenant-rivetquay","flag":{"module":"ai","enabled":true},"unit":"actions","allowance":12,"windowStart":"2026-11-01T00:00:00Z","windowEnd":"2026-12-01T00:00:00Z"}'::jsonb),
  ('tenant-spoolharbour', 'records:actions', '{"tenantId":"tenant-spoolharbour","flag":{"module":"records","enabled":true},"unit":"actions","allowance":40,"windowStart":"2026-11-01T00:00:00Z","windowEnd":"2026-12-01T00:00:00Z"}'::jsonb),
  ('tenant-spoolharbour', 'procurement:actions', '{"tenantId":"tenant-spoolharbour","flag":{"module":"procurement","enabled":true},"unit":"actions","allowance":40,"windowStart":"2026-11-01T00:00:00Z","windowEnd":"2026-12-01T00:00:00Z"}'::jsonb),
  ('tenant-spoolharbour', 'collections:actions', '{"tenantId":"tenant-spoolharbour","flag":{"module":"collections","enabled":true},"unit":"actions","allowance":40,"windowStart":"2026-11-01T00:00:00Z","windowEnd":"2026-12-01T00:00:00Z"}'::jsonb),
  ('tenant-spoolharbour', 'workflows:actions', '{"tenantId":"tenant-spoolharbour","flag":{"module":"workflows","enabled":true},"unit":"actions","allowance":40,"windowStart":"2026-11-01T00:00:00Z","windowEnd":"2026-12-01T00:00:00Z"}'::jsonb),
  ('tenant-spoolharbour', 'insights:actions', '{"tenantId":"tenant-spoolharbour","flag":{"module":"insights","enabled":true},"unit":"actions","allowance":40,"windowStart":"2026-11-01T00:00:00Z","windowEnd":"2026-12-01T00:00:00Z"}'::jsonb),
  ('tenant-spoolharbour', 'ai:actions', '{"tenantId":"tenant-spoolharbour","flag":{"module":"ai","enabled":true},"unit":"actions","allowance":12,"windowStart":"2026-11-01T00:00:00Z","windowEnd":"2026-12-01T00:00:00Z"}'::jsonb);
CREATE TABLE IF NOT EXISTS demo_fixture.purchase_order (tenant_id text NOT NULL, id text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY (tenant_id, id));
TRUNCATE demo_fixture.purchase_order;
COMMIT;
