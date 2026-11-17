"""Compare Docker images under the same 1-vCPU quota with two log sources.

Both images must support TOML configuration (legacy env-only images are unsupported).
Usage: python3 tests/performance/run.py BASELINE_IMAGE CANDIDATE_IMAGE [COUNT]
Build fixture first: docker build -t nexus-agent-bench-fixture tests/performance
"""
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request
import uuid
import tempfile


def docker(*args, check=True):
    return subprocess.run(["docker", *args], text=True, capture_output=True, check=check).stdout.strip()


def measure(image, count):
    prefix="lagbench-"+uuid.uuid4().hex[:8]
    network=prefix+"-net"; volume=prefix+"-socket"; server=prefix+"-server"; agent=prefix+"-agent"
    temporary=tempfile.TemporaryDirectory(prefix="nexus-agent-bench-")
    try:
        docker("network","create",network)
        docker("volume","create",volume)
        docker("run","-d","--name",server,"--network",network,"-p","127.0.0.1::8080",
               "-v",volume+":/fixture","nexus-agent-bench-fixture")
        info=json.loads(docker("inspect",server))[0]
        port=info["NetworkSettings"]["Ports"]["8080/tcp"][0]["HostPort"]
        url=f"http://127.0.0.1:{port}"
        def get(path):
            with urllib.request.urlopen(url+path, timeout=5) as response:
                return json.load(response)
        for _ in range(100):
            try:
                get("/control/state")
                break
            except (OSError, ValueError):
                time.sleep(.1)
        config=Path(temporary.name)/"nexus-agent.toml"
        values=dict(server_url=f"http://{server}:8080/api/track_batch",auth_token="benchmark",node_ip="1.1.1.1",docker_socket="/fixture/docker.sock")
        config.write_text("\n".join(f"{k} = {json.dumps(v)}" for k,v in values.items()))
        docker("run","-d","--name",agent,"--network",network,"--cpus","1","--memory","256m",
               "-v",volume+":/fixture:ro","-v",f"{config}:/etc/nexus-agent/nexus-agent.toml:ro",image)
        for _ in range(200):
            if get("/control/state")["streams"]==2:
                break
            time.sleep(.1)
        else:
            raise RuntimeError("agent did not connect both sources: "+docker("logs",agent,check=False))
        def stats():
            raw=json.loads(docker("stats","--no-stream","--format","{{json .}}",agent))
            number,unit=re.match(r"([0-9.]+)([A-Za-z]+)",raw["MemUsage"].split("/")[0].strip()).groups()
            mib=float(number)*{"B":1/1048576,"KiB":1/1024,"MiB":1,"GiB":1024}[unit]
            return dict(working_set_mib=mib,cpu_percent=float(raw["CPUPerc"].strip("%")),pids=int(raw["PIDs"]))
        idle=stats()
        get(f"/control/start?count={count}")
        samples=[]
        deadline=time.monotonic()+180
        while time.monotonic()<deadline:
            samples.append(stats())
            state=get("/control/state")
            if state["end"]:
                break
        else:
            raise RuntimeError("benchmark timeout: "+json.dumps(get("/control/state")))
        assert state["accepted"]==count, state
        elapsed=state["end"]-state["begin"]
        return dict(image=image,containers=2,cpu_quota=1,batch_size=500,events=count,
                    elapsed_s=round(elapsed,3),events_per_s=round(count/elapsed),idle=idle,
                    sampled_peak_working_set_mib=max(s["working_set_mib"] for s in samples),
                    sampled_peak_pids=max(s["pids"] for s in samples),samples=samples)
    except Exception:
        subprocess.run(["docker","logs",agent], check=False)
        raise
    finally:
        docker("rm","-f",agent,server,check=False)
        docker("volume","rm",volume,check=False)
        docker("network","rm",network,check=False)
        temporary.cleanup()


if __name__=="__main__":
    results=[]
    for image in sys.argv[1:3]:
        result=measure(image,int(sys.argv[3]) if len(sys.argv)>3 else 100000)
        results.append(result)
        print(json.dumps(result,indent=2),flush=True)
    Path("target/performance-results.json").write_text(json.dumps(results,indent=2))
