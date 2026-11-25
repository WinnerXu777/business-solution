"""Explainable rules and a reproducible synthetic logistic baseline."""

from dataclasses import dataclass
from functools import cache
from math import exp, log1p
from random import Random

from ..contracts_v1 import (
    ContractModel,
    Count,
    Id,
    ScoreFraudOutput,
    ScoreFraudOutputModel,
    ScoreFraudOutputRule,
)

SEED = 20261125
ARTIFACT_ID = "synthetic-fraud-logistic-v1"
RULE_VERSION = "fraud-rules-v1"
SIGNAL_WEIGHTS = {
    "rush_request": 0.20,
    "unusual_order_value": 0.35,
    "delivery_address_changed": 0.45,
}
FEATURE_NAMES = ("intercept", "log_order_value", *SIGNAL_WEIGHTS)


class FraudOrder(ContractModel):
    id: Id
    totalCents: Count
    signals: list[str]


def features(total_cents: int, signals: list[str]) -> tuple[float, ...]:
    return (
        1.0,
        log1p(total_cents / 100_000),
        *(float(signal in signals) for signal in SIGNAL_WEIGHTS),
    )


def sigmoid(logit: float) -> float:
    return 1 / (1 + exp(-logit))


def predict(weights: tuple[float, ...] | list[float], inputs: tuple[float, ...]) -> float:
    return sigmoid(sum(weight * value for weight, value in zip(weights, inputs, strict=True)))


def synthetic_orders() -> list[tuple[tuple[float, ...], int]]:
    rng = Random(SEED)
    rows = []
    for _ in range(640):
        total = rng.randrange(5_000, 650_000)
        signals = [
            signal
            for signal, prevalence in zip(SIGNAL_WEIGHTS, (0.25, 0.35, 0.20), strict=True)
            if rng.random() < prevalence
        ]
        inputs = features(total, signals)
        # Simulated outcomes include noise and deliberately differ from the rule weights.
        probability = predict((-3.2, 1.05, 0.8, 1.15, 1.75), inputs)
        rows.append((inputs, int(rng.random() < probability)))
    return rows


@dataclass(frozen=True)
class FraudArtifact:
    artifact_id: str
    seed: int
    feature_names: tuple[str, ...]
    weights: tuple[float, ...]
    training_rows: int
    holdout_rows: int
    holdout_brier_score: float


@cache
def train() -> FraudArtifact:
    rows = synthetic_orders()
    training, holdout = rows[:512], rows[512:]
    weights = [0.0] * len(FEATURE_NAMES)
    for _ in range(240):
        gradient = [0.0] * len(weights)
        for inputs, label in training:
            error = predict(weights, inputs) - label
            for index, value in enumerate(inputs):
                gradient[index] += error * value
        for index, derivative in enumerate(gradient):
            penalty = 0.01 * weights[index] if index else 0.0
            weights[index] -= 0.45 * (derivative / len(training) + penalty)

    brier = sum((predict(weights, inputs) - label) ** 2 for inputs, label in holdout) / len(holdout)
    return FraudArtifact(
        artifact_id=ARTIFACT_ID,
        seed=SEED,
        feature_names=FEATURE_NAMES,
        weights=tuple(weights),
        training_rows=len(training),
        holdout_rows=len(holdout),
        holdout_brier_score=round(brier, 6),
    )


def score(order: FraudOrder) -> ScoreFraudOutput:
    triggered = [signal for signal in SIGNAL_WEIGHTS if signal in order.signals]
    rule_score = round(min(1.0, 0.05 + sum(SIGNAL_WEIGHTS[reason] for reason in triggered)), 6)
    artifact = train()
    model_score = round(predict(artifact.weights, features(order.totalCents, order.signals)), 6)
    return ScoreFraudOutput(
        orderId=order.id,
        rule=ScoreFraudOutputRule(score=rule_score, reasons=triggered, version=RULE_VERSION),
        model=ScoreFraudOutputModel(score=model_score, artifactId=artifact.artifact_id),
        disposition="review" if max(rule_score, model_score) >= 0.5 else "pass",
    )
