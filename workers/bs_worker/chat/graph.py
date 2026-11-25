"""Fixture-independent LangGraph entry point for lane B."""

from typing import TypedDict

from langgraph.graph import END, START, StateGraph


class ChatState(TypedDict):
    session_id: str


def build_graph():
    graph = StateGraph(ChatState)
    graph.add_edge(START, END)
    return graph.compile()
