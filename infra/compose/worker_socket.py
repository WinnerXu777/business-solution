"""Serve the existing fixture stdio worker on a private Compose volume socket."""

import os
import socket
import subprocess
import sys
from pathlib import Path

path = Path(os.environ["BS_WORKER_SOCKET"])
path.unlink(missing_ok=True)
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
    listener.bind(str(path))
    path.chmod(0o600)
    listener.listen(1)
    while True:
        connection, _ = listener.accept()
        with connection:
            subprocess.run(
                [sys.executable, "-m", "workers.bs_worker.chat.stdio"],
                stdin=connection,
                stdout=connection,
                check=False,
            )
