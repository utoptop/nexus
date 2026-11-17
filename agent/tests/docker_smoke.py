"""Real Docker Engine smoke test for native streaming and stock log formats.

Requires local images logger-agent:performance-local and nexus-agent-bench-fixture.
Creates/removes only uniquely named test resources.
"""
import json
import os
import subprocess
import time
import urllib.request
import uuid


def docker(*args, check=True):
    return subprocess.run(["docker", *args],text=True,capture_output=True,check=check).stdout.strip()


prefix="lag-smoke-"+uuid.uuid4().hex[:8]
network=prefix+"-net"; server=prefix+"-server"; source=prefix+"-nginx"; agent=prefix+"-agent"
try:
    docker("network","create",network)
    docker("run","-d","--name",server,"--network",network,"-p","127.0.0.1::8080","nexus-agent-bench-fixture")
    port=json.loads(docker("inspect",server))[0]["NetworkSettings"]["Ports"]["8080/tcp"][0]["HostPort"]
    records=[
        '8.8.8.8 - - [17/Nov/2026:12:00:00 +0800] "GET / HTTP/1.1" 200 100 "-" "test"',
        'haproxy[42]: 9.9.9.9:1234 [17/Nov/2026:12:00:00.000] front back/srv 0/0/1/2/3 200 123 - - ---- 1/1/1/1/0 0/0 "GET / HTTP/1.1"',
        'TRACK_L7|8.8.4.4|example.com',
    ]
    code="import time,sys;time.sleep(5);"+";".join(f"print({record!r},file=sys.{'stderr' if i==1 else 'stdout'},flush=True)" for i,record in enumerate(records))+";time.sleep(2)"
    docker("run","-d","--name",source,"--log-driver","json-file","--entrypoint","python3","nexus-agent-bench-fixture","-u","-c",code)
    docker("run","-d","--name",agent,"--network",network,"-v","/var/run/docker.sock:/var/run/docker.sock:ro",
           "-e",f"SERVER_URL=http://{server}:8080/api/track_batch","-e","AUTH_TOKEN=smoke",
           "-e","NODE_IP=1.1.1.1","-e",f"MONITOR_CONTAINERS={source}",os.environ.get("AGENT_IMAGE", "utoptop/nexus-agent:1.0"))
    def accepted():
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/control/state",timeout=5) as response:
            return json.load(response)["accepted"]
    for _ in range(300):
        if accepted()==3:break
        time.sleep(.1)
    else:raise AssertionError("did not receive three records")
    time.sleep(8)  # source exits and agent reconnects using fractional --since equivalent
    assert accepted()==3,"reconnect duplicated logs"
    docker("stop","-t","20",agent)
    assert json.loads(docker("inspect",agent))[0]["State"]["ExitCode"]==0
    print("PASS: real Docker API, nginx combined + HAProxy HTTP + TRACK_L7, stdout/stderr, reconnect dedup, SIGTERM")
except Exception:
    subprocess.run(["docker","logs",agent],check=False)
    raise
finally:
    docker("rm","-f",agent,source,server,check=False)
    docker("network","rm",network,check=False)
