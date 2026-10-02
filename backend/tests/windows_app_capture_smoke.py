"""Windows 原生 hybrid 验证：非回环 ETW TCP/UDP，以及握手预热后的回环 TCP EStats。"""
import argparse
import ctypes
import ipaddress
import json
import multiprocessing
import os
from pathlib import Path
import queue
import socket
import subprocess
import sys
import threading
import time


def endpoint(address, port, scope=0):
    return (address, port, 0, scope) if ":" in address else (address, port)


def receive(connection, size):
    payload = bytearray()
    while len(payload) < size:
        chunk = connection.recv(size - len(payload))
        assert chunk, "连接在接收完成前关闭"
        payload.extend(chunk)
    return bytes(payload)


def hold(release):
    assert release.wait(60), "父进程未释放测试连接"


def server(family, address, scope, datagram, ready, connected, transmit, done, release):
    with socket.socket(family, socket.SOCK_DGRAM if datagram else socket.SOCK_STREAM) as listener:
        listener.settimeout(30)
        listener.bind(endpoint(address, 0, scope))
        if not datagram:
            listener.listen(1)
        ready.put(listener.getsockname()[1])
        if datagram:
            connected.put(os.getpid())
            assert transmit.wait(30), "未收到传输指令"
            payload, remote = listener.recvfrom(8192)
            assert len(payload) == 4096
            listener.sendto(payload, remote)
            done.put(os.getpid())
            hold(release)
        else:
            connection, _ = listener.accept()
            with connection:
                connection.settimeout(30)
                connected.put(os.getpid())
                assert transmit.wait(30), "未收到传输指令"
                payload = receive(connection, 65536)
                connection.sendall(payload)
                done.put(os.getpid())
                # EStats 必须在这个 accepted socket 仍存在时读取字节。
                hold(release)


def client(family, address, scope, datagram, port, connected, transmit, done, release):
    with socket.socket(family, socket.SOCK_DGRAM if datagram else socket.SOCK_STREAM) as connection:
        connection.settimeout(30)
        connection.bind(endpoint(address, 0, scope))
        connection.connect(endpoint(address, port, scope))
        connected.put(os.getpid())
        assert transmit.wait(30), "未收到传输指令"
        payload = b"w" * (4096 if datagram else 65536)
        connection.sendall(payload)
        assert receive(connection, len(payload)) == payload
        done.put(os.getpid())
        hold(release)


def local_addresses():
    # 系统已有地址，无 DNS 查询、路由探测或对外请求。IPv6 保留 scope。
    command = ("$ErrorActionPreference='Stop'; "
               "Get-NetIPAddress -AddressState Preferred | "
               "Select-Object IPAddress,InterfaceIndex | ConvertTo-Json -Compress")
    result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
                            capture_output=True, text=True, encoding="utf-8", errors="replace",
                            creationflags=subprocess.CREATE_NO_WINDOW, timeout=30, check=True)
    rows = json.loads(result.stdout.strip() or "[]")
    if isinstance(rows, dict):
        rows = [rows]
    candidates = {socket.AF_INET: [], socket.AF_INET6: []}
    for row in rows:
        address = ipaddress.ip_address(row["IPAddress"].split("%", 1)[0])
        if address.is_loopback or address.is_unspecified or address.is_multicast:
            continue
        if address.version == 6 and address.ipv4_mapped:
            continue
        family = socket.AF_INET if address.version == 4 else socket.AF_INET6
        scope = int(row["InterfaceIndex"]) if address.version == 6 and address.is_link_local else 0
        try:
            with socket.socket(family, socket.SOCK_STREAM) as probe:
                probe.bind(endpoint(str(address), 0, scope))
        except OSError as error:
            print(f"地址不可绑定 {address}%{scope}: {error}", flush=True)
            continue
        candidates[family].append((str(address), scope))
    for addresses in candidates.values():
        addresses.sort(key=lambda item: (ipaddress.ip_address(item[0]).is_link_local, item))
    assert any(candidates.values()), "没有可绑定的非回环 IPv4/IPv6 地址；必需 ETW 验证不能整组跳过"
    return candidates


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


def wait_snapshot(helper, reports, generation, predicate, label):
    deadline = time.monotonic() + 15
    while True:
        report = snapshot(helper, reports)
        assert report["state"] in ["running", "partial"], report
        assert report["generation"] == generation, report
        if predicate(report):
            return report
        assert time.monotonic() < deadline, (label, report)
        time.sleep(0.1)


def test_connection(context, helper, reports, generation, family, address, scope, datagram, loopback):
    ready, connected, done = context.Queue(), context.Queue(), context.Queue()
    transmit, release = context.Event(), context.Event()
    children = []
    source = "WindowsTcpEStats" if loopback else "WindowsEtw"
    label = f"{source} IPv{4 if family == socket.AF_INET else 6} {'UDP' if datagram else 'TCP'} {address}"
    try:
        serving = context.Process(target=server, args=(family, address, scope, datagram, ready, connected, transmit, done, release))
        serving.start()
        children.append(serving)
        port = ready.get(timeout=15)
        sending = context.Process(target=client, args=(family, address, scope, datagram, port, connected, transmit, done, release))
        sending.start()
        children.append(sending)
        pids = {connected.get(timeout=15), connected.get(timeout=15)}
        assert pids == {serving.pid, sending.pid}, (label, pids)

        def selected(report):
            rows = [row for row in report["samples"] if row["processId"] in pids]
            for row in rows:
                assert row.get("source") == source, ("错误来源或重复采样", label, row)
                assert (row["interfaceId"] == "loopback") == loopback, (label, row)
                assert row["active"] and row["appId"] != "unknown", (label, row)
                if loopback:
                    assert row.get("connectionKey"), row
            return rows

        if loopback:
            warm = wait_snapshot(helper, reports, generation,
                                 lambda report: {row["processId"] for row in selected(report)} == pids,
                                 label + " warmup")
            baseline = selected(warm)
            assert len(baseline) == 2, ("回环连接端点重复", baseline)
            assert all(int(row["rxBytes"]) == 0 and int(row["txBytes"]) == 0 for row in baseline), baseline
        # TCP/UDP ETW 在已启动会话内传输；回环 TCP 则确认 EStats 基线后才发数据。
        transmit.set()
        assert {done.get(timeout=30), done.get(timeout=30)} == pids
        expected = 4096 if datagram else 65536

        def measured(report):
            rows = selected(report)
            return {row["processId"] for row in rows} == pids and all(
                int(row["rxBytes"]) >= expected and int(row["txBytes"]) >= expected for row in rows)

        report = wait_snapshot(helper, reports, generation, measured, label + " bytes")
        rows = selected(report)
        assert len({row["appId"] for row in rows}) == 1, rows
        if loopback:
            assert len(rows) == 2, rows
            assert all(int(row["rxBytes"]) == expected and int(row["txBytes"]) == expected for row in rows), rows
        identities = {(row["instanceId"], row["interfaceId"]): row for row in rows}
        repeated = snapshot(helper, reports)
        for key, row in identities.items():
            again = next(item for item in repeated["samples"] if (item["instanceId"], item["interfaceId"]) == key)
            assert int(again["rxBytes"]) >= int(row["rxBytes"]), again
            assert int(again["txBytes"]) >= int(row["txBytes"]), again
        release.set()
        for child in children:
            child.join(timeout=10)
            assert child.exitcode == 0, (label, child.pid, child.exitcode)

        def closed(report):
            remaining = {(row["instanceId"], row["interfaceId"]): row for row in report["samples"]
                         if (row["instanceId"], row["interfaceId"]) in identities}
            if loopback:
                # 轮询连接关闭后行可消失，不要求 ETW 风格的退出后最终行。
                return all(not row["active"] for row in remaining.values())
            if len(remaining) != len(identities) or any(row["active"] for row in remaining.values()):
                return False
            for key, row in remaining.items():
                old = identities[key]
                assert row["appId"] == old["appId"], row
                assert int(row["rxBytes"]) >= int(old["rxBytes"]), row
                assert int(row["txBytes"]) >= int(old["txBytes"]), row
            return True

        wait_snapshot(helper, reports, generation, closed, label + " closed")
        print(f"PASS: {label}; 双进程归属、字节、重复快照、关闭语义", flush=True)
    finally:
        transmit.set()
        release.set()
        for child in children:
            child.join(timeout=2)
            if child.is_alive():
                child.terminate()
                child.join(timeout=2)
        for channel in (ready, connected, done):
            channel.close()


def main():
    sys.stdout.reconfigure(encoding="utf-8")
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
        print("SKIP: hybrid 验证需要原生 Windows，不能用 Wine 代替。")
        return 1 if args.require_native else 77
    if not ctypes.windll.shell32.IsUserAnAdmin():
        print("SKIP: hybrid 原生验证需要以管理员权限运行。")
        return 1 if args.require_native else 77
    addresses = local_addresses()
    helper = subprocess.Popen([str(args.helper.resolve()), "--stdio"], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, bufsize=0, creationflags=subprocess.CREATE_NO_WINDOW)
    reports = queue.Queue()
    threading.Thread(target=read_reports, args=(helper, reports), daemon=True).start()
    context = multiprocessing.get_context("spawn")
    try:
        initial = response(reports)
        assert initial["state"] == "running", initial
        generation = initial["generation"]
        etw_cases = 0
        for family in (socket.AF_INET, socket.AF_INET6):
            candidates = addresses[family]
            if not candidates:
                print(f"NOT AVAILABLE: ETW IPv{4 if family == socket.AF_INET else 6} 无可绑定非回环地址", flush=True)
                continue
            address, scope = candidates[0]
            for datagram in (False, True):
                test_connection(context, helper, reports, generation, family, address, scope, datagram, False)
                etw_cases += 1
        assert etw_cases >= 2, "至少完成一个非回环地址族的 ETW TCP 和 UDP 实测"
        for family, address in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
            test_connection(context, helper, reports, generation, family, address, 0, False, True)
        helper.stdin.write(b"shutdown\n")
        helper.stdin.close()
        assert helper.wait(timeout=15) == 0
        print(f"PASS: hybrid native; ETW cases={etw_cases}, EStats cases=2", flush=True)
    finally:
        if helper.poll() is None:
            if not helper.stdin.closed:
                helper.stdin.close()
            helper.wait(timeout=15)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
