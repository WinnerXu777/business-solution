"""Minimal graph smoke entry point."""

from .chat.graph import build_graph

print(build_graph().invoke({"session_id": "fixture-session"}))
