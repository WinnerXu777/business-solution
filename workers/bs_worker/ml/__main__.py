"""Local JSON-lines scoring process and deterministic artifact export."""

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Annotated, Literal, TextIO

from pydantic import Field, TypeAdapter

from ..contracts_v1 import ContractModel, Id, RunForecastInput
from .forecast import forecast
from .fraud import FraudOrder, score, train
from .profile import ProfileCustomer, profile

ARTIFACT_DIR = Path(__file__).resolve().parent / ".cache"


class FraudRequest(ContractModel):
    operation: Literal["fraud"]
    order: FraudOrder


class ForecastRequest(ContractModel):
    operation: Literal["forecast"]
    tenantId: Id | None
    input: RunForecastInput


class ProfileRequest(ContractModel):
    operation: Literal["profile"]
    customer: ProfileCustomer
    supportingOrders: list[Id]


request_type = TypeAdapter(
    Annotated[FraudRequest | ForecastRequest | ProfileRequest, Field(discriminator="operation")]
)


def serve(source: TextIO, destination: TextIO) -> None:
    for line in source:
        try:
            request = request_type.validate_json(line)
            if isinstance(request, FraudRequest):
                output = score(request.order)
            elif isinstance(request, ForecastRequest):
                output = forecast(request.tenantId, request.input)
            else:
                output = profile(request.customer, request.supportingOrders)
            response = {"state": "ok", "output": output.model_dump(mode="json")}
        except ValueError:
            response = {"state": "failed", "code": "invalid_input"}
        print(json.dumps(response, separators=(",", ":")), file=destination, flush=True)


def export_artifact(destination: Path) -> Path:
    destination.mkdir(parents=True, exist_ok=True)
    artifact = train()
    target = destination / (artifact.artifact_id + ".json")
    with NamedTemporaryFile(mode="w", encoding="utf-8", dir=destination, delete=False) as staged:
        temporary_path = Path(staged.name)
    try:
        temporary_path.write_text(json.dumps(asdict(artifact), indent=2) + "\n", encoding="utf-8")
        temporary_path.replace(target)
    finally:
        temporary_path.unlink(missing_ok=True)
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("serve", "train"), default="serve", nargs="?")
    if parser.parse_args().command == "train":
        print(export_artifact(ARTIFACT_DIR))
    else:
        serve(sys.stdin, sys.stdout)


if __name__ == "__main__":
    main()
