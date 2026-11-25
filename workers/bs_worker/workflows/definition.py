"""Validated workflow definitions and deterministic, side-effect-free transitions."""

from typing import Annotated, Literal

from pydantic import Field, model_validator

from ..contracts_v1 import ContractModel, Id, ReadOrderInput

Scalar = Annotated[str, Field(max_length=1000)] | Annotated[int, Field(
    ge=-9_007_199_254_740_991, le=9_007_199_254_740_991,
)] | bool | None


class Reference(ContractModel):
    ref: Id


Value = Scalar | Reference


class Trigger(ContractModel):
    id: Id
    kind: Literal["trigger"]
    trigger: Literal["manual", "schedule", "event"]
    name: Id | None = None
    next: Id

    @model_validator(mode="after")
    def valid_name(self):
        if (self.trigger == "manual") != (self.name is None):
            raise ValueError("Event and schedule triggers require a name")
        return self


class Condition(ContractModel):
    id: Id
    kind: Literal["condition"]
    left: Value
    equals: Scalar
    next: Id
    otherwise: Id | None


class Mapping(ContractModel):
    id: Id
    kind: Literal["mapping"]
    values: dict[Id, Value] = Field(max_length=32)
    next: Id


class Delay(ContractModel):
    id: Id
    kind: Literal["delay"]
    milliseconds: int = Field(ge=1, le=604_800_000)
    next: Id


class ApprovalNode(ContractModel):
    id: Id
    kind: Literal["approval"]
    next: Id


class OrderAction(ContractModel):
    tool: Literal["order.read"]
    orderId: Id | Reference


class TemplateAction(ContractModel):
    tool: Literal["workflow.template.run"]
    templateId: Literal["win-back-v1"]


class Action(ContractModel):
    id: Id
    kind: Literal["action"]
    action: Annotated[OrderAction | TemplateAction, Field(discriminator="tool")]
    next: Id | None = None
    maxAttempts: int = Field(default=3, ge=1, le=5)
    backoffMs: int = Field(default=1000, ge=1, le=60_000)


Node = Annotated[Trigger | Condition | Mapping | Delay | ApprovalNode | Action, Field(discriminator="kind")]


def edges(node):
    return [target for target in (node.next, getattr(node, "otherwise", None)) if target is not None]


class Definition(ContractModel):
    id: Id
    version: int = Field(ge=1, le=2_147_483_647)
    nodes: list[Node] = Field(min_length=2, max_length=40)

    @model_validator(mode="after")
    def validate_graph(self):
        nodes = {node.id: node for node in self.nodes}
        if len(nodes) != len(self.nodes) or not isinstance(self.nodes[0], Trigger):
            raise ValueError("Workflow needs unique node IDs and an initial trigger")
        if any(isinstance(node, Trigger) for node in self.nodes[1:]):
            raise ValueError("Only the initial node can be a trigger")
        incoming = {key: set() for key in nodes}
        for node in self.nodes:
            for target in edges(node):
                if target not in nodes:
                    raise ValueError("Unknown node reference")
                incoming[target].add(node.id)

        visited = set()
        visiting = set()

        def visit(node_id):
            if node_id in visiting:
                raise ValueError("Workflow must be acyclic")
            if node_id in visited:
                return
            visiting.add(node_id)
            for target in edges(nodes[node_id]):
                visit(target)
            visiting.remove(node_id)
            visited.add(node_id)

        visit(self.nodes[0].id)
        if len(visited) != len(nodes):
            raise ValueError("Every node must be reachable")
        for node in self.nodes:
            if isinstance(node, ApprovalNode) and not is_effect(nodes[node.next]):
                raise ValueError("Approval must lead to a dispatch action")
            if is_effect(node) and (
                len(incoming[node.id]) != 1
                or not isinstance(nodes[next(iter(incoming[node.id]))], ApprovalNode)
            ):
                raise ValueError("Dispatch must have exactly one incoming approval node")
        return self


class TriggerReceipt(ContractModel):
    kind: Literal["manual", "event", "schedule"]
    name: Id | None = None
    key: Id | None = None


class StartInput(ContractModel):
    trigger: TriggerReceipt
    values: dict[Id, Scalar] = Field(default_factory=dict, max_length=32)


def validate_trigger(definition: Definition, receipt: TriggerReceipt):
    trigger = definition.nodes[0]
    if (trigger.trigger, trigger.name) != (receipt.kind, receipt.name):
        raise ValueError("Trigger does not match the published definition")
    if (receipt.kind == "manual") != (receipt.key is None):
        raise ValueError("Event and schedule receipts require a stable key")


def resolve(value: Value, values: dict) -> Scalar:
    return values[value.ref] if isinstance(value, Reference) else value


def is_effect(node) -> bool:
    return isinstance(node, Action) and isinstance(node.action, TemplateAction)


def action_input(node: Action, values: dict, approval_id=None):
    if is_effect(node):
        return {"templateId": node.action.templateId, "mode": "run", "approvalId": approval_id}
    order_id = resolve(node.action.orderId, values)
    return ReadOrderInput.model_validate({"orderId": order_id}).model_dump()


def transition(node: Node, values: dict) -> tuple[str | None, dict]:
    """Advance a control node using only pinned input and definition."""
    if isinstance(node, Condition):
        left = resolve(node.left, values)
        match = type(left) is type(node.equals) and left == node.equals
        return (node.next if match else node.otherwise), values
    if isinstance(node, Mapping):
        return node.next, {**values, **{key: resolve(value, values) for key, value in node.values.items()}}
    return node.next, values


def preview(definition: Definition, start: StartInput) -> list[dict]:
    validate_trigger(definition, start.trigger)
    nodes = {node.id: node for node in definition.nodes}
    cursor = definition.nodes[0].id
    values = start.values
    plan = []
    while cursor is not None:
        node = nodes[cursor]
        entry = {"nodeId": node.id, "kind": node.kind}
        if isinstance(node, Action):
            entry.update(tool=node.action.tool, input=action_input(node, values))
        if isinstance(node, Delay):
            entry["milliseconds"] = node.milliseconds
        plan.append(entry)
        cursor, values = transition(node, values)
    return plan


WIN_BACK = Definition.model_validate({
    "id": "win-back-v1",
    "version": 1,
    "nodes": [
        {"id": "manual", "kind": "trigger", "trigger": "manual", "next": "approve"},
        {"id": "approve", "kind": "approval", "next": "send"},
        {"id": "send", "kind": "action", "action": {
            "tool": "workflow.template.run", "templateId": "win-back-v1",
        }},
    ],
})
