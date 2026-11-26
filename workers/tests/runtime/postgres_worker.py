"""Fixture worker entry point with fake Postgres state across child processes."""

from os import environ

from workers.bs_worker.chat.stdio import main
from workers.bs_worker.runtime.postgres import PostgresBotStore
from .fake_postgres import FakeRuntimeExecutor

if __name__ == "__main__":
    main(store=PostgresBotStore(FakeRuntimeExecutor(environ["BS_TEST_RUNTIME_STATE"])))
