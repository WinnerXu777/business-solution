import json
import unittest
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from workers.bs_worker.contracts_v1 import (
    DemoFixtures,
    RunForecastInput,
    RunProfileOutput,
    ScoreFraudOutput,
)
from workers.bs_worker.ml.__main__ import export_artifact, serve
from workers.bs_worker.ml.forecast import baseline, forecast
from workers.bs_worker.ml.fraud import FraudOrder, score, train


class InsightTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture = Path("packages/contracts/fixtures/demo.json")
        cls.demo = DemoFixtures.model_validate_json(fixture.read_text(encoding="utf-8"))

    def test_rules_distinguish_seeded_orders_and_model_retrains(self):
        outputs = {}
        for order in self.demo.orders:
            if order.id in ("ord-003", "ord-004"):
                inputs = order.model_dump(include={"id", "totalCents", "signals"})
                outputs[order.id] = score(FraudOrder.model_validate(inputs))
        first, second = outputs["ord-003"], outputs["ord-004"]
        self.assertEqual(first.rule.reasons, ["rush_request", "unusual_order_value"])
        self.assertEqual(second.rule.reasons, ["unusual_order_value", "delivery_address_changed"])
        self.assertEqual(first.disposition, "review")
        self.assertEqual(second.disposition, "review")
        self.assertLess(first.rule.score, second.rule.score)
        self.assertLess(first.model.score, second.model.score)

        with TemporaryDirectory() as directory:
            artifact = export_artifact(Path(directory))
            first_export = artifact.read_bytes()
            train.cache_clear()
            self.assertEqual(export_artifact(Path(directory)).read_bytes(), first_export)
            manifest = json.loads(first_export)
            self.assertEqual(manifest["artifact_id"], first.model.artifactId)
            self.assertEqual(manifest["seed"], 20261125)
            self.assertEqual(manifest["holdout_rows"], 128)
            self.assertLess(manifest["holdout_brier_score"], 0.25)

    def test_forecast_combines_baselines_and_abstains_for_sparse_history(self):
        self.assertEqual(baseline((10, 20, 30, 40), 2), 22.5)
        self.assertEqual(baseline((10, 20, 30, 40), 6), 22.5)
        tenant = "tenant-rivetquay"
        sales = forecast(tenant, RunForecastInput(series="weekly_sales", skuId=None, horizonWeeks=12))
        self.assertEqual((sales.status, sales.unit, len(sales.points)), ("fixture", "cents", 12))
        self.assertEqual(sales.points[0].weekOf, "2026-11-23")
        self.assertEqual(sales.points[-1].weekOf, "2027-02-08")
        for point in sales.points:
            self.assertLessEqual(0, point.lower)
            self.assertLess(point.lower, point.estimate)
            self.assertLess(point.estimate, point.upper)
        sparse = forecast(
            tenant, RunForecastInput(series="sku_demand", skuId="sku-002", horizonWeeks=1)
        )
        self.assertEqual(
            (sparse.status, sparse.unit, sparse.points), ("insufficient_history", "items", [])
        )
        foreign = forecast(
            "tenant-spoolharbour",
            RunForecastInput(series="weekly_sales", skuId=None, horizonWeeks=1),
        )
        self.assertEqual((foreign.status, foreign.points), ("insufficient_history", []))

    def test_stdio_validates_lines_and_completes_all_insights_with_zero_network_calls(self):
        order = next(order for order in self.demo.orders if order.id == "ord-003")
        customer = next(customer for customer in self.demo.customers if customer.id == "cust-008")
        requests = [
            {
                "operation": "fraud",
                "order": order.model_dump(include={"id", "totalCents", "signals"}),
            },
            {
                "operation": "forecast",
                "tenantId": customer.tenantId,
                "input": {"series": "sku_demand", "skuId": "sku-001", "horizonWeeks": 2},
            },
            {
                "operation": "profile",
                "customer": customer.model_dump(include={"id", "lastOrderOn", "outreachAllowed"}),
                "supportingOrders": ["ord-008"],
            },
        ]
        source = StringIO("invalid json\n" + "\n".join(json.dumps(request) for request in requests))
        destination = StringIO()
        train.cache_clear()
        with (
            patch("socket.socket", side_effect=AssertionError("network attempted")) as socket,
            patch("socket.getaddrinfo", side_effect=AssertionError("DNS attempted")) as dns,
        ):
            serve(source, destination)
        socket.assert_not_called()
        dns.assert_not_called()
        failed, fraud, prediction, profile = map(json.loads, destination.getvalue().splitlines())
        self.assertEqual(failed, {"state": "failed", "code": "invalid_input"})
        self.assertEqual(ScoreFraudOutput.model_validate(fraud["output"]).orderId, "ord-003")
        self.assertEqual(len(prediction["output"]["points"]), 2)
        review = RunProfileOutput.model_validate(profile["output"])
        self.assertEqual(
            (review.segment, review.evidenceIds, review.reviewRequired),
            ("win_back", ["cust-008", "ord-008"], True),
        )
