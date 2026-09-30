"""Windows 原生 ETW 验证：通过回环验证 TCP/UDP、IPv4/IPv6 和双进程归属。"""
import argparse
import ctypes
import json
import multiprocessing
import os
from pathlib import Path
import queue
import socket
import subprocess
import threading
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
                    chunk = connection.recv(65536 - len(payload))
                    assert chunk, "TCP 接收提前结束"
                    payload += chunk
                connection.sendall(payload)
        done.put(os.getpid())
        release.wait(30)


def client(family, datagram, port, done, release):
    address = "127.0.0.1" if family == socket.AF_INET else "::1"
    with socket.socket(family, socket.SOCK_DGRAM if datagram else socket.SOCK_STREAM) as connection:
        connection.settimeout(10)
        connection.connect((address, port))
        payload = b"w" * (4096 if datagram else 65536)
        connection.sendall(payload)
        reply = b""
        while len(reply) < len(payload):
            chunk = connection.recv(len(payload) - len(reply))
            assert chunk, "回包提前结束"
            reply += chunk
        assert reply == payload
        done.put(os.getpid())
        release.wait(30)


def read_reports(helper, reports):
    for line in iter(helper.stdout.readline, b""):
        try:
            reports.put(json.loads(line))
        except (ValueError, UnicodeError) as error:
            reports.put(error)
    reports.put(RuntimeError("采集辅助进程提前退出"))


def response(reports):
    report = reports.get(timeout=15)
    if isinstance(report, Exception):
        raise report
    return report


def snapshot(helper, reports):
    helper.stdin.write(b"read\n")
    helper.stdin.flush()
    return response(reports)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("helper", type=Path)
    parser.add_argument("--require-native", action="store_true")
    args = parser.parse_args()
    wine = False
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetModuleHandleW.argtypes = [ctypes.c_wchar_p]
        kernel.GetModuleHandleW.restype = ctypes.c_void_p
        kernel.GetProcAddress.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        kernel.GetProcAddress.restype = ctypes.c_void_p
        wine = bool(kernel.GetProcAddress(kernel.GetModuleHandleW("ntdll.dll"), b"wine_get_version"))
    if os.name != "nt" or wine:
        print("SKIP: ETW 验证需要原生 Windows，不能用 Wine 代替。")
        return 1 if args.require_native else 77
    if not ctypes.windll.shell32.IsUserAnAdmin():
        print("SKIP: ETW 原生验证需要以管理员权限运行。")
        return 1 if args.require_native else 77
    helper = subprocess.Popen([str(args.helper.resolve()), "--stdio"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0)
    reports = queue.Queue()
    threading.Thread(target=read_reports, args=(helper, reports), daemon=True).start()
    context = multiprocessing.get_context("spawn")
    children, releases = [], []
    try:
        initial = response(reports)
        assert initial["state"] == "running", initial
        generation = initial["generation"]
        instances = set()
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
                expected = 4096 if datagram else 65536
                deadline = time.monotonic() + 10
                while True:
                    report = snapshot(helper, reports)
                    assert report["state"] in ["running", "partial"], report
                    assert report["generation"] == generation, report
                    samples = [sample for sample in report["samples"] if sample["processId"] in pids]
                    if {sample["processId"] for sample in samples} == pids and all(
                        int(sample["rxBytes"]) >= expected and int(sample["txBytes"]) >= expected for sample in samples
                    ):
                        break
                    assert time.monotonic() < deadline, (pids, report)
                    time.sleep(0.1)
                for sample in samples:
                    assert sample["active"] and sample["appId"] != "unknown", sample
                    assert sample["instanceId"] not in instances, sample
                    assert sample["interfaceId"], sample
                instances.update(sample["instanceId"] for sample in samples)
                assert len({sample["appId"] for sample in samples}) == 1, samples
                repeated = snapshot(helper, reports)
                for sample in samples:
                    again = next(item for item in repeated["samples"] if item["instanceId"] == sample["instanceId"] and item["interfaceId"] == sample["interfaceId"])
                    assert int(again["rxBytes"]) >= int(sample["rxBytes"]), again
                    assert int(again["txBytes"]) >= int(sample["txBytes"]), again
                release.set()
                for child in [serving, sending]:
                    child.join(timeout=10)
                    assert child.exitcode == 0, child.exitcode
                final = snapshot(helper, reports)
                for sample in samples:
                    closed = next(item for item in final["samples"] if item["instanceId"] == sample["instanceId"] and item["interfaceId"] == sample["interfaceId"])
                    assert not closed["active"] and closed["appId"] == sample["appId"], closed
                print(f"PASS: {'IPv4' if family == socket.AF_INET else 'IPv6'} {'UDP' if datagram else 'TCP'}，双进程收发、应用归并与最终计数")
        helper.stdin.write(b"shutdown\n")
        helper.stdin.close()
        assert helper.wait(timeout=15) == 0
    finally:
        for release in releases:
            release.set()
        for child in children:
            child.join(timeout=2)
            if child.is_alive():
                child.terminate()
                child.join(timeout=2)
        if helper.poll() is None:
            if not helper.stdin.closed:
                helper.stdin.close()
            helper.wait(timeout=15)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
