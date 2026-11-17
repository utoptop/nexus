"""Process-level recovery test; Python standard library only, no real Docker/server.

Run after cargo build: python3 tests/recovery.py target/debug/nexus-agent
"""
import datetime
import http.server
import os
import json
import socket
import socketserver
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time


def eventually(check, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.05)
    raise AssertionError("timed out waiting for recovery")


def run(binary):
    with tempfile.TemporaryDirectory(prefix="logger-agent-recovery-") as temporary:
        root = Path(temporary)
        available = threading.Event()
        accepted = []
        rejected = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                payload = self.rfile.read(int(self.headers["Content-Length"]))
                assert self.headers["Authorization"] == "Bearer test-token"
                assert self.headers["X-Node-IP"] == "1.1.1.1"
                assert self.headers["Content-Type"] == "application/msgpack"
                is_event = self.path == "/api/track_batch" and payload != b"\x90"
                status = 200
                if not available.is_set() or (is_event and not rejected):
                    status = 503
                    if is_event:
                        rejected.append(payload)
                elif is_event:
                    accepted.append(payload)
                self.send_response(status)
                self.send_header("Retry-After", "1")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *_):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        # Timestamp the first delivered fixture after collection starts. Under
        # build/CI load process startup may take longer than one second, and a
        # timestamp prepared before startup would correctly be outside --since.
        stamp = None
        class DockerHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                nonlocal stamp
                if self.path.startswith("/containers/json"):
                    data = json.dumps([{"Id": "a"*64, "Names": ["/test"], "Image": "nginx", "State": "running"}]).encode()
                elif self.path.endswith("/json"):
                    data = json.dumps({"Id":"a"*64,"Config":{"Tty":False},"State":{"Running":True}}).encode()
                elif "/logs?" in self.path:
                    assert "since=" in self.path and "timestamps=1" in self.path
                    if stamp is None:
                        stamp = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=1)).isoformat()
                    lines = [(1, f"{stamp} TRACK_L7|8.8.8.8|alpha.example\n"),
                             (2, f"{stamp} TRACK_L7|9.9.9.9|beta.example\n")]
                    if (root / "second-start").exists():
                        lines.append((1, f"{stamp} TRACK_L7|8.8.4.4|gamma.example\n"))
                    data = b"".join(bytes([kind,0,0,0])+len(line.encode()).to_bytes(4,"big")+line.encode() for kind,line in lines)
                else:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Length",str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            def log_message(self,*_):
                pass
        class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
            daemon_threads = True
        docker_server=UnixServer(str(root/"docker.sock"),DockerHandler)
        threading.Thread(target=docker_server.serve_forever,daemon=True).start()
        config = root / "nexus-agent.toml"
        values = dict(server_url=f"http://127.0.0.1:{server.server_port}/api/track_batch",
                      auth_token="test-token", node_ip="1.1.1.1", monitor_containers=["test"],
                      state_dir=str(root/"data"), docker_socket=str(root/"docker.sock"))
        config.write_text("\n".join(f"{k} = {json.dumps(v)}" for k,v in values.items()))
        # Conflicting legacy settings must not override the file.
        env = dict(os.environ, SERVER_URL="ignored-invalid-url", AUTH_TOKEN="ignored", NO_PROXY="*")
        for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "METRICS_URL"]:
            env.pop(key, None)

        def queue_count():
            try:
                with sqlite3.connect(root / "data/agent.sqlite3") as db:
                    return db.execute("SELECT count(*) FROM queue").fetchone()[0]
            except sqlite3.OperationalError:
                return -1

        process = None
        try:
            with (root / "agent.log").open("w+") as log:
                process = subprocess.Popen([binary,"--config",str(config)], env=env, stdout=log, stderr=log)
                # Collection must proceed while the handshake is rejected.
                eventually(lambda: queue_count() == 2)
                process.send_signal(signal.SIGTERM)
                assert process.wait(timeout=18) == 0
                assert queue_count() == 2
                (root / "second-start").touch()
                available.set()
                process = subprocess.Popen([binary,"--config",str(config)], env=env, stdout=log, stderr=log)
                eventually(lambda: queue_count() == 0 and len(accepted) > 0)
                eventually(lambda: b"gamma.example" in b"".join(accepted))
                # Exercise one reconnect with inclusive replay of all three lines.
                time.sleep(6)
                process.send_signal(signal.SIGTERM)
                assert process.wait(timeout=18) == 0
                assert queue_count() == 0
                assert rejected, "expected a rejected event batch"
                joined = b"".join(accepted)
                for domain in [b"alpha.example", b"beta.example", b"gamma.example"]:
                    assert joined.count(domain) == 1, (domain, accepted)
                print("PASS: collect during failed handshake; persist across SIGTERM/restart; retry 503; stdout/stderr replay without duplicates")
        except Exception:
            print((root / "agent.log").read_text(), file=sys.stderr)
            raise
        finally:
            if process is not None and process.poll() is None:
                process.kill()
                process.wait()
            server.shutdown()
            server.server_close()
            docker_server.shutdown()
            docker_server.server_close()


if __name__ == "__main__":
    run(str(Path(sys.argv[1]).resolve()))
