"""Deterministic Docker log API + iplogger ACK fixture, standard library only.

This measures the agent, not PostgreSQL/GeoIP/iplogger capacity. Run in a separate
container; a Unix socket is shared with the agent via the /fixture volume.
"""
import datetime
import http.server
import json
import os
import socketserver
import threading
import time
from urllib.parse import parse_qs, urlsplit

condition = threading.Condition()
state = dict(started=False, count=0, accepted=0, begin=0.0, end=0.0, streams=0)
containers = [dict(Id=f"{i+1:064x}", Names=[f"/nginx-bench-{i}"], Image="nginx", State="running") for i in range(2)]


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def reply(self, value):
        data = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        data = self.rfile.read(int(self.headers["Content-Length"]))
        if self.path == "/api/track_batch":
            if 0x90 <= data[0] <= 0x9f:
                count = data[0] - 0x90
            elif data[0] == 0xdc:
                count = int.from_bytes(data[1:3], "big")
            elif data[0] == 0xdd:
                count = int.from_bytes(data[1:5], "big")
            else:
                raise AssertionError("expected MessagePack array")
            with condition:
                state["accepted"] += count
                if state["started"] and state["accepted"] >= state["count"]:
                    state["end"] = time.monotonic()
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        url = urlsplit(self.path)
        path = url.path
        if path.startswith("/v1."):
            path = "/" + path.split("/", 2)[2]
        if path == "/control/start":
            with condition:
                state["count"] = int(parse_qs(url.query)["count"][0])
                state["begin"] = time.monotonic()
                state["started"] = True
                condition.notify_all()
            self.reply(state)
        elif path == "/control/state":
            with condition:
                self.reply(dict(state))
        elif path in ("/version", "/_ping"):
            self.reply(dict(ApiVersion="1.56", MinAPIVersion="1.40", Version="29.0.0", Os="linux"))
        elif path == "/containers/json":
            self.reply(containers)
        elif path.endswith("/json"):
            self.reply(dict(Id=path.split("/")[2], Name="/nginx-bench", Config=dict(Tty=False), State=dict(Running=True)))
        elif path.endswith("/logs"):
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.docker.multiplexed-stream")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            self.wfile.flush()
            with condition:
                state["streams"] += 1
                condition.wait_for(lambda: state["started"])
                count = state["count"] // len(containers)
            stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000000000Z")
            body = f"{stamp} TRACK_L7|8.8.8.8|example.com\n".encode()
            frames = [bytes([kind, 0, 0, 0])+len(body).to_bytes(4, "big")+body for kind in (1,2)]
            try:
                for start in range(0, count, 256):
                    chunk = b"".join(frames[i % 2] for i in range(start, min(start+256,count)))
                    self.wfile.write(f"{len(chunk):x}\r\n".encode()+chunk+b"\r\n")
                self.wfile.flush()
                # Keep the follow connection open; no artificial replay during timing.
                time.sleep(600)
            except (BrokenPipeError, ConnectionResetError):
                pass
        else:
            self.send_error(404)

    def do_HEAD(self):
        self.send_response(200)
        self.send_header("API-Version", "1.56")
        self.send_header("OSType", "linux")
        self.send_header("Content-Length", "0")
        self.end_headers()


class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


os.makedirs("/fixture", exist_ok=True)
try:
    os.unlink("/fixture/docker.sock")
except FileNotFoundError:
    pass
unix = UnixServer("/fixture/docker.sock", Handler)
threading.Thread(target=unix.serve_forever, daemon=True).start()
http.server.ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
