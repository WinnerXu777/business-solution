"""Shared JSON Schema and typed graph rules for the workflow builder."""

import json
import re
from pathlib import Path

SCHEMA = json.loads((
    Path(__file__).resolve().parents[3] / "packages/core/src/workflows/definition.schema.json"
).read_text(encoding="utf-8"))
ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}")
WRITES = {"message", "create-record", "update-record", "http"}


def matches(value, rule):
    """Validate the Draft 2020-12 vocabulary used by the bundled schema."""
    if "$ref" in rule:
        return matches(value, SCHEMA["$defs"][rule["$ref"].removeprefix("#/$defs/")])
    if "oneOf" in rule:
        return sum(matches(value, choice) for choice in rule["oneOf"]) == 1
    if "anyOf" in rule:
        return any(matches(value, choice) for choice in rule["anyOf"])
    if "const" in rule:
        return value == rule["const"]
    if "enum" in rule:
        return value in rule["enum"]

    kind = rule["type"]
    if kind == "object":
        if not isinstance(value, dict) or len(value) > rule.get("maxProperties", len(value)):
            return False
        if any(key not in value for key in rule.get("required", [])):
            return False
        names = rule.get("propertyNames")
        if names and any(not matches(key, names) for key in value):
            return False
        properties, additional = rule.get("properties", {}), rule.get("additionalProperties")
        return all(
            isinstance(spec := properties.get(key, additional), dict) and matches(item, spec)
            for key, item in value.items()
        )
    if kind == "array":
        return (
            isinstance(value, list) and rule["minItems"] <= len(value) <= rule["maxItems"]
            and all(matches(item, rule["items"]) for item in value)
        )
    if kind == "string":
        if not isinstance(value, str):
            return False
        if "pattern" in rule and not re.fullmatch(rule["pattern"], value):
            return False
        return rule.get("minLength", 0) <= len(value) <= rule.get("maxLength", len(value))
    if kind == "integer":
        return (
            (type(value) is int or (type(value) is float and value.is_integer()))
            and rule["minimum"] <= value <= rule["maximum"]
        )
    if kind == "boolean":
        return type(value) is bool
    if kind == "null":
        return value is None
    raise ValueError(f"Unsupported schema type {kind}")


def value_type(value):
    if type(value) is float and value.is_integer():
        return "integer"
    return {str: "string", int: "integer", bool: "boolean", list: "string-list", type(None): "null"}.get(type(value))


def edges(node):
    kind = node["kind"]
    if kind == "loop-end":
        return []
    if kind == "loop":
        return [node["body"], node["next"]]
    if kind == "switch":
        return [*(case["next"] for case in node["cases"]), node["otherwise"]]
    if kind in {"branch", "ab-split"}:
        return [node["next"], node["otherwise"]]
    if kind in {"wait-for-event", "human-task"}:
        return [node["next"], node["onTimeout"]]
    return [node["next"]]


def validate_definition(definition, connectors=frozenset()):
    if not matches(definition, SCHEMA):
        raise ValueError("Definition does not match workflow schema")
    nodes = {node["id"]: node for node in definition["nodes"]}
    root = definition["nodes"][0]["id"]
    if len(nodes) != len(definition["nodes"]) or nodes[root]["kind"] != "trigger":
        raise ValueError("Expected an initial trigger and unique node IDs")
    if "draft" in definition["inputs"].values():
        raise ValueError("Only the drafting node can produce draft values")
    order, visiting, visited = [], set(), set()

    def visit(node_id):
        if node_id in visiting:
            raise ValueError("Cycle outside a bounded loop")
        if node_id in visited:
            return
        if node_id not in nodes:
            raise ValueError(f"Unknown node {node_id}")
        visiting.add(node_id)
        for target in edges(nodes[node_id]):
            if target is not None:
                visit(target)
        visiting.remove(node_id)
        visited.add(node_id)
        order.append(node_id)

    visit(root)
    if len(visited) != len(nodes):
        raise ValueError("Unreachable node")

    incoming = {root: (definition["inputs"].copy(), None)}
    loops = set()
    for node_id in reversed(order):
        node = nodes[node_id]
        kind = node["kind"]
        fields, loop = incoming[node_id]
        output = fields.copy()

        def require(value, *types):
            actual = fields.get(value["ref"]) if isinstance(value, dict) else value_type(value)
            if not actual or (types and actual not in types):
                raise ValueError(f"Invalid input type or unavailable field at {node_id}")
            return actual

        if kind == "trigger" and node_id != root:
            raise ValueError("Only the first node can be a trigger")
        if kind == "mapping":
            output.update({key: require(value) for key, value in node["values"].items()})
        if kind == "branch":
            require(node["left"], value_type(node["equals"]))
        if kind == "switch":
            labels = [(value_type(case["equals"]), case["equals"]) for case in node["cases"]]
            if len(set(labels)) != len(labels):
                raise ValueError("Duplicate switch case")
            for label, _ in labels:
                require(node["value"], label)
        if kind == "loop":
            if loop or node["body"] == node["next"]:
                raise ValueError("Loop requires distinct paths and cannot be nested")
            require(node["items"], "string-list")
        if kind == "loop-end":
            if loop != node["loop"]:
                raise ValueError("Loop end has no matching loop")
            loops.add(loop)
        if kind == "checkpoint" and loop:
            raise ValueError("Checkpoint inside loop")
        if kind in {"wait-for-event", "ab-split"}:
            require(node["key"], "string")
        if kind == "human-task":
            require(node["title"], "string")
        if kind == "llm-draft":
            require(node["prompt"], "string")
            output[node["output"]] = "draft"
        if kind == "message":
            require(node["recipientId"], "string")
            require(node["sourceId"], "string")
            if "body" in node:
                require(node["body"], "string", "draft")
        if kind in {"create-record", "update-record", "http"}:
            if kind == "http":
                if (node["connector"], node["operation"]) not in connectors:
                    raise ValueError("Connector operation is not allowlisted")
            else:
                require(node["summary"], "string")
            require(node["subjectId" if kind == "create-record" else "recordId"], "string")
            output[node["output"]] = "string"

        for target in edges(node):
            if target is None:
                if loop:
                    raise ValueError("Loop path must finish at a loop end")
                continue
            enters_loop = kind == "loop" and target == node["body"]
            available, owner = output.copy(), node_id if enters_loop else loop
            if enters_loop:
                available[node["item"]] = "string"
            if target not in incoming:
                incoming[target] = available, owner
            else:
                previous, previous_owner = incoming[target]
                if previous_owner != owner:
                    raise ValueError("Loop body crosses graph boundary")
                incoming[target] = {key: typ for key, typ in previous.items() if available.get(key) == typ}, owner

    if any(node["kind"] == "loop" and node["id"] not in loops for node in nodes.values()):
        raise ValueError("Missing loop end")
    return definition


def validate_inputs(definition, values):
    if not isinstance(values, dict) or values.keys() != definition["inputs"].keys():
        raise ValueError("Expected exactly the declared input fields")
    for name, value in values.items():
        if value_type(value) != definition["inputs"][name] or not matches(value, SCHEMA["$defs"]["value"]):
            raise ValueError(f"Invalid value for input {name}")
    return values


def migration_prefix(definition, checkpoint):
    """All possible ancestors and the checkpoint itself must be identical."""
    incoming = {node["id"]: [] for node in definition["nodes"]}
    nodes = {node["id"]: node for node in definition["nodes"]}
    if checkpoint not in nodes or nodes[checkpoint]["kind"] != "checkpoint":
        raise ValueError("Missing migration checkpoint")
    for node in nodes.values():
        for target in edges(node):
            if target is not None:
                incoming[target].append(node["id"])
    prefix = {}
    stack = [checkpoint]
    while stack:
        node_id = stack.pop()
        if node_id not in prefix:
            prefix[node_id] = nodes[node_id]
            stack.extend(incoming[node_id])
    # Loop body edges return implicitly. Include all possible iterations of prefix loops.
    stack = [node["body"] for node in prefix.values() if node["kind"] == "loop"]
    while stack:
        node_id = stack.pop()
        if node_id not in prefix:
            prefix[node_id] = nodes[node_id]
            stack.extend(target for target in edges(nodes[node_id]) if target is not None)
    return prefix

