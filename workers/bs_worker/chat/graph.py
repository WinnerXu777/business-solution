"""Fixture chat and browser voice share this graph and its governed tools."""

from typing import TypedDict

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

from ..contracts_v1 import CallEnvelope, RunChatInput
from .gateway import Gateway


class ChatState(TypedDict, total=False):
    session_id: str
    envelope: dict
    chat: dict
    proposal: dict | None
    pending: dict | None
    result: dict | None


def _key(envelope: dict, step: str) -> dict:
    return {**envelope, "idempotencyKey": envelope["idempotencyKey"] + ":" + step}


def build_graph(gateway: Gateway | None = None):
    graph = StateGraph(ChatState)
    # Keep the existing worker boot smoke usable without a gateway connection.
    if gateway is None:
        graph.add_edge(START, END)
        return graph.compile()

    def answer(state: ChatState) -> dict:
        envelope = CallEnvelope.model_validate(state["envelope"]).model_dump()
        chat = RunChatInput.model_validate(state["chat"])
        llm = gateway("llm.complete", _key(envelope, "model"), {
            "model": "fixture-chat",
            "maxOutputTokens": 24,
            "turns": [turn.model_dump() for turn in chat.turns],
            "route": chat.route.model_dump(),
        })
        if llm["state"] != "ok":
            return {"result": llm}

        proposal = (
            {"tool": "order.read", "input": {"orderId": chat.orderId}}
            if chat.orderId else state.get("proposal")
        )
        if proposal is None:
            return _answer(chat.sessionId, "Ask for an order number, purchase request, or invoice.")
        tool, inputs = proposal["tool"], proposal["input"]
        if tool not in {"order.read", "purchase.order.draft", "message.preview"}:
            raise ValueError("Unsupported chat proposal")
        result = gateway(tool, _key(envelope, "proposal"), inputs)
        if result["state"] != "ok":
            return {"result": result}
        output = result["output"]
        if tool == "order.read":
            return _answer(chat.sessionId, f'Order {output["id"]} is {output["status"]}.', output)
        if tool == "purchase.order.draft":
            if output["approval"]["state"] != "pending":
                return {"result": {
                    "state": "denied", "code": "invalid_approval",
                    "message": "The purchase order draft is already resolved.",
                }}
            return {"pending": {"approval": output["approval"], "draft": output["draft"]}}

        send = gateway(
            f'collections.{output["channel"]}.send',
            _key(envelope, "prepare"),
            {"previewId": output["id"], "approvalId": None},
        )
        if send["state"] != "pending_approval":
            return {"result": send}
        return {"pending": {"approval": send["approval"], "previews": [output]}}

    def wait_for_approval(state: ChatState) -> dict:
        pending = state["pending"]
        approval = pending["approval"]
        decision = CallEnvelope.model_validate(interrupt(pending)).model_dump()
        if (
            decision["tenantId"] != approval["tenantId"]
            or decision["actor"]["id"] != approval["approverId"]
            or decision["actor"]["id"] == approval["requestedBy"]
        ):
            return {"result": {"state": "denied", "code": "invalid_approval", "message": "Invalid approver."}}
        if approval["tool"] == "purchase.order.approve":
            result = gateway(approval["tool"], _key(decision, "execute"), {
                "draftId": approval["subjectId"], "approvalId": approval["id"],
            })
        else:
            # The host signs the grant with the designated approver before resuming.
            result = gateway(approval["tool"], _key(state["envelope"], "execute"), {
                "previewId": approval["subjectId"], "approvalId": approval["id"],
            })
        return {"pending": None, "result": result}

    graph.add_node("answer", answer)
    graph.add_node("approval", wait_for_approval)
    graph.add_edge(START, "answer")
    graph.add_conditional_edges("answer", lambda state: "approval" if state.get("pending") else END)
    graph.add_edge("approval", END)
    return graph.compile(checkpointer=InMemorySaver())


def _answer(session_id: str, reply: str, order: dict | None = None) -> dict:
    return {"result": {"state": "ok", "output": {
        "sessionId": session_id, "reply": reply, "order": order, "handoff": order is None,
    }}}
