"""Fixture chat and browser voice share this graph and its governed tools."""

from typing import TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import Interrupt, interrupt

from ..contracts_v1 import CallEnvelope, RunChatInput
from ..runtime.bots import BotDefinition, BotRegistry, BotRuntime, denied
from ..runtime.store import MemoryBotStore
from .gateway import Gateway


class ChatInput(TypedDict, total=False):
    envelope: dict
    chat: dict
    proposal: dict | None


class ChatState(ChatInput, total=False):
    session_id: str
    pending: dict | None
    execution: dict | None
    result: dict | None


SEND_TOOLS = {
    "email": "collections.email.send",
    "sms": "collections.sms.send",
    "voice": "collections.voice.send",
}


def _compile(call, saver):
    graph = StateGraph(ChatState, input_schema=ChatInput)

    def answer(state: ChatState) -> dict:
        chat = RunChatInput.model_validate(state["chat"])
        expected_provider = {"native": "fixture-native", "byo": "fixture-byo"}[chat.route.kind]
        if not chat.route.fixtureMode or chat.route.providerId != expected_provider:
            return {"result": denied("forbidden")}
        llm = call("model", "llm.complete", {
            "model": "fixture-chat",
            "maxOutputTokens": 24,
            "turns": [turn.model_dump() for turn in chat.turns],
            "route": chat.route.model_dump(),
        })
        if llm["state"] != "ok":
            return {"result": llm}

        # The fixture router proposes from the user turn. LLM text and retrieved
        # strings never become tool names, instructions, approval decisions or scope.
        proposal = (
            {"tool": "order.read", "input": {"orderId": chat.orderId}}
            if chat.orderId else state.get("proposal")
        )
        if proposal is None:
            return _answer(chat.sessionId, "Ask for an order number, purchase request, or invoice.")
        tool, inputs = proposal["tool"], proposal["input"]
        if tool not in {"order.read", "purchase.order.draft", "message.preview"}:
            raise ValueError("Unsupported chat proposal")
        result = call("proposal", tool, inputs)
        if result["state"] != "ok":
            return {"result": result}
        output = result["output"]
        if tool == "order.read":
            if output["id"] != inputs["orderId"] or output["tenantId"] != state["envelope"]["tenantId"]:
                return {"result": denied("not_found")}
            return _answer(chat.sessionId, f'Order {output["id"]} is {output["status"]}.', output)
        if tool == "purchase.order.draft":
            draft = output["draft"]
            if draft["tenantId"] != state["envelope"]["tenantId"] or draft["requestId"] != inputs["requestId"]:
                return {"result": denied("not_found")}
            return _pending(
                state, {"approval": output["approval"], "draft": draft},
                "purchase.order.approve", "draftId", draft["id"],
            )

        channel = inputs["channel"]
        if (
            output["tenantId"] != state["envelope"]["tenantId"] or output["channel"] != channel
            or output["sourceId"] != inputs["invoiceId"]
        ):
            return {"result": denied("not_found")}
        send_tool = SEND_TOOLS[channel]
        send = call("prepare", send_tool, {"previewId": output["id"], "approvalId": None})
        if send["state"] != "pending_approval":
            return {"result": send}
        return _pending(
            state, {"approval": send["approval"], "previews": [output]},
            send_tool, "previewId", output["id"],
        )

    def wait_for_approval(state: ChatState) -> dict:
        pending = state["pending"]
        approval = pending["approval"]
        decision = CallEnvelope.model_validate(interrupt(pending)).model_dump()
        if (
            decision["tenantId"] != approval["tenantId"]
            or decision["actor"] != {"id": approval["approverId"], "kind": "person"}
            or decision["actor"]["id"] == approval["requestedBy"]
        ):
            return {"result": denied("invalid_approval")}
        execution = state["execution"]
        result = call(
            "execute", execution["tool"], execution["input"],
            approver=execution["tool"] == "purchase.order.approve",
        )
        return {"pending": None, "result": result}

    graph.add_node("answer", answer)
    graph.add_node("approval", wait_for_approval)
    graph.add_edge(START, "answer")
    graph.add_conditional_edges("answer", lambda state: "approval" if state.get("pending") else END)
    graph.add_edge("approval", END)
    return graph.compile(checkpointer=saver)


def _pending(state, pending, tool, subject_field, subject_id):
    approval = pending["approval"]
    if (
        approval["state"] != "pending" or approval["tool"] != tool
        or approval["subjectId"] != subject_id
        or approval["tenantId"] != state["envelope"]["tenantId"]
        or approval["requestedBy"] != state["envelope"]["actor"]["id"]
    ):
        return {"result": denied("invalid_approval")}
    return {
        "pending": pending,
        "execution": {"tool": tool, "input": {subject_field: subject_id, "approvalId": approval["id"]}},
    }


CHAT = BotDefinition(
    "fixture-chat", 1, _compile,
    frozenset({"llm.complete", "order.read", "purchase.order.draft", "purchase.order.approve",
               "message.preview", *SEND_TOOLS.values()}),
    max_actions=4, max_seconds=10,
)


def build_graph(gateway: Gateway | None = None):
    """Compatibility entry point for the original graph smoke and direct fixtures."""
    if gateway is None:
        graph = StateGraph(ChatState)
        graph.add_edge(START, END)
        return graph.compile()
    store = MemoryBotStore()
    runtime = BotRuntime(BotRegistry(CHAT), store, gateway)

    class FixtureGraph:
        def invoke(self, value, config):
            run_id = config["configurable"]["thread_id"]
            if isinstance(value, dict):
                run = runtime.start(run_id, CHAT.id, CHAT.version, value["envelope"], {
                    "chat": value["chat"], "proposal": value.get("proposal"),
                })
            else:
                scope = value.resume
                pending = store.load(scope["tenantId"], run_id)
                if not pending or not pending.pending:
                    return {"result": denied("not_found")}
                try:
                    run = runtime.resume(run_id, scope, pending.pending["approval"]["id"])
                except KeyError:
                    return {"result": denied("invalid_approval")}
            if run.pending:
                return {"__interrupt__": [Interrupt(value=run.pending, id=run_id)]}
            return {"result": run.result}

    return FixtureGraph()


def _answer(session_id: str, reply: str, order: dict | None = None) -> dict:
    return {"result": {"state": "ok", "output": {
        "sessionId": session_id, "reply": reply, "order": order, "handoff": order is None,
    }}}
