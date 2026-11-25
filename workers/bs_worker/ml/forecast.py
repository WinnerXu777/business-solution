"""Weekly forecasts over a deterministic dataset for the Rivetquay demo."""

from datetime import date, timedelta
from math import ceil
from statistics import mean

from ..contracts_v1 import ForecastPoint, RunForecastInput, RunForecastOutput

ARTIFACT_ID = "synthetic-weekly-baselines-v1"
LAST_COMPLETE_WEEK = date(2026, 11, 16)
SEASON_WEEKS = 4
MIN_BACKTESTS = 4

# Twenty-eight consecutive complete weeks of fictional sales. SKU 002 has only three.
SKU_001_UNITS = (
    36, 43, 48, 39, 37, 44, 52, 41, 42, 48, 54, 40, 39, 49,
    58, 44, 42, 51, 55, 46, 45, 50, 60, 43, 43, 53, 63, 48,
)
DEMO_HISTORY = {"sku-001": SKU_001_UNITS, "sku-002": (8, 9, 6)}


def baseline(history: tuple[int, ...], horizon: int) -> float:
    recent = history[-SEASON_WEEKS:]
    seasonal_naive = recent[(horizon - 1) % SEASON_WEEKS]
    moving_average = mean(recent)
    return (seasonal_naive + moving_average) / 2


def forecast(tenant_id: str | None, request: RunForecastInput) -> RunForecastOutput:
    is_sales = request.series == "weekly_sales"
    unit = "cents" if is_sales else "items"
    # The v1 gateway takes no SKU for weekly_sales. This demo series covers sku-001.
    sku = request.skuId or ("sku-001" if is_sales else None)
    history = DEMO_HISTORY.get(sku, ()) if tenant_id == "tenant-rivetquay" else ()
    if is_sales:
        history = tuple(units * 2450 for units in history)

    if len(history) - request.horizonWeeks - SEASON_WEEKS + 1 < MIN_BACKTESTS:
        return RunForecastOutput(
            status="insufficient_history", unit=unit, artifactId=ARTIFACT_ID, points=[]
        )

    points = []
    for horizon in range(1, request.horizonWeeks + 1):
        errors = sorted(
            abs(history[end + horizon - 1] - baseline(history[:end], horizon))
            for end in range(SEASON_WEEKS, len(history) - horizon + 1)
        )
        # Use the empirical 90th percentile of rolling-origin absolute errors for this lead.
        band = max(1, ceil(errors[ceil(0.9 * len(errors)) - 1]))
        estimate = round(baseline(history, horizon))
        points.append(
            ForecastPoint(
                weekOf=(LAST_COMPLETE_WEEK + timedelta(weeks=horizon)).isoformat(),
                estimate=estimate,
                lower=max(0, estimate - band),
                upper=estimate + band,
            )
        )
    return RunForecastOutput(status="fixture", unit=unit, artifactId=ARTIFACT_ID, points=points)
