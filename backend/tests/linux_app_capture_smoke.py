"""真实内核采集验证：仅通过本机回环发送测试数据，不改动 Wi-Fi 或路由。"""
import argparse
import json
import multiprocessing
import os
from pathlib import Path
import select
import socket
import subprocess
import time


def server(family, datagram, ready, done, release):
    address = "127.0.0.1" if family == socket.AF_INET else "::1"
    with socket.socket(family, socket.SOCK_DGRAM if datagram else socket.SOCK_STREAM) as listener:
        listener.settimeout(10)
        listener.bind((address, 0))
        if not datagram:
            listener.listen(1)
        ready.put(listener.getsockname()[1])
        if datagram:
            payload, remote = listener.recvfrom(8192)
            listener.sendto(payload, remote)
        else:
            connection, _ = listener.accept()
            with connection:
                payload = b""
                while len(payload) < 65536:
                    payload += connection.recv(65536 - len(payload))
                connection.sendall(payload)
        done.put(os.getpid())
        release.wait(15)


def client(family, datagram, port, done, release):
    address = "127.0.0.1" if family == socket.AF_INET else "::1"
    with socket.socket(family, socket.SOCK_DGRAM if datagram else socket.SOCK_STREAM) as connection:
        connection.settimeout(10)
        connection.connect((address, port))
        payload = b"w" * (4096 if datagram else 65536)
        connection.sendall(payload)
        reply = b""
        while len(reply) < len(payload):
            reply += connection.recv(len(payload) - len(reply))
        assert reply == payload
        done.put(os.getpid())
        release.wait(15)


def response(helper):
    deadline = time.monotonic() + 15
    # 使用无缓冲二进制管道，不让 TextIOWrapper 的预读干扰 select。
    line = bytearray()
    while time.monotonic() < deadline:
        if not select.select([helper.stdout], [], [], max(0, deadline - time.monotonic()))[0]:
            break
        byte = os.read(helper.stdout.fileno(), 1)
        if not byte:
            raise RuntimeError(f"采集辅助进程提前退出：{helper.poll()}")
        if byte == b"\n":
            return json.loads(line)
        line.extend(byte)
    raise TimeoutError("采集辅助进程未响应")


def snapshot(helper):
    helper.stdin.write(b"read\n")
    helper.stdin.flush()
    return response(helper)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("helper", type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0:
        print("SKIP: 真实 eBPF 验证需要系统授权；以 root 运行此脚本。")
        return 77
    context = multiprocessing.get_context("spawn")
    helper = subprocess.Popen([str(args.helper.resolve())], stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0)
    children = []
    releases = []
    try:
        initial = response(helper)
        assert initial["state"] == "running", initial
        generation = initial["generation"]
        previous_instances = set()
        for family in [socket.AF_INET, socket.AF_INET6]:
            for datagram in [False, True]:
                ready, done, release = context.Queue(), context.Queue(), context.Event()
                releases.append(release)
                serving = context.Process(target=server, args=(family, datagram, ready, done, release))
                serving.start()
                children.append(serving)
                port = ready.get(timeout=15)
                sending = context.Process(target=client, args=(family, datagram, port, done, release))
                sending.start()
                children.append(sending)
                pids = {done.get(timeout=15), done.get(timeout=15)}
                report = snapshot(helper)
                assert report["generation"] == generation, report
                samples = [sample for sample in report["samples"] if sample["processId"] in pids and sample["interfaceId"] == "lo"]
                assert {sample["processId"] for sample in samples} == pids, (pids, report)
                expected = 4096 if datagram else 65536
                for sample in samples:
                    assert sample["active"] and sample["appId"] != "unknown", sample
                    assert int(sample["rxBytes"]) >= expected and int(sample["txBytes"]) >= expected, sample
                    assert sample["instanceId"] not in previous_instances, sample
                previous_instances.update(sample["instanceId"] for sample in samples)
                assert len({sample["appId"] for sample in samples}) == 1, samples
                # 重复读取保持累计计数；退出后保留最终计数并标记非活动。
                repeated = snapshot(helper)
                for sample in samples:
                    again = next(item for item in repeated["samples"] if item["instanceId"] == sample["instanceId"] and item["interfaceId"] == "lo")
                    assert int(again["rxBytes"]) >= int(sample["rxBytes"]), again
                release.set()
                for child in [serving, sending]:
                    child.join(timeout=10)
                    assert child.exitcode == 0, child.exitcode
                final = snapshot(helper)
                for sample in samples:
                    closed = next(item for item in final["samples"] if item["instanceId"] == sample["instanceId"] and item["interfaceId"] == "lo")
                    assert not closed["active"] and closed["appId"] == sample["appId"], closed
                print(f"PASS: {'IPv4' if family == socket.AF_INET else 'IPv6'} {'UDP' if datagram else 'TCP'}，双进程身份、收发与最终计数")
        helper.stdin.write(b"shutdown\n")
        helper.stdin.close()
        assert helper.wait(timeout=10) == 0
    finally:
        for release in releases:
            release.set()
        for child in children:
            child.join(timeout=2)
            if child.is_alive():
                child.terminate()
                child.join(timeout=2)
        if helper.poll() is None:
            if helper.stdin and not helper.stdin.closed:
                helper.stdin.close()
            helper.terminate()
            helper.wait(timeout=10)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
