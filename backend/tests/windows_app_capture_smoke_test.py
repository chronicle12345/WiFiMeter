"""无管理员权限验证原生测试的握手与必需 ETW 覆盖规则。"""
import multiprocessing
import queue
import socket
import subprocess
import unittest
from unittest.mock import patch

import windows_app_capture_smoke as smoke


class NativeSmokeHarnessTest(unittest.TestCase):
    def test_target_selection_excludes_other_sockets_owned_by_same_process(self):
        target = {11: "9:127.0.0.1:54444>9:127.0.0.1:54445",
                  22: "9:127.0.0.1:54445>9:127.0.0.1:54444"}
        rows = [{"processId": pid, "connectionKey": key} for pid, key in target.items()]
        unrelated = [{"processId": 11, "connectionKey": "other", "txBytes": "40"},
                     {"processId": 33, "connectionKey": target[11]},
                     {"processId": 11, "connectionKey": target[22]}]
        self.assertEqual(smoke.target_samples({"samples": unrelated + rows}, set(target), target), rows)

    def test_target_selection_preserves_extra_bytes_on_target_socket(self):
        key = "9:127.0.0.1:54445>9:127.0.0.1:54444"
        row = {"processId": 22, "connectionKey": key, "rxBytes": "65536", "txBytes": "65576"}
        self.assertEqual(smoke.target_samples({"samples": [row]}, {22}, {22: key}), [row])
        smoke.assert_payload_bytes([row], 65536)
        self.assertEqual(row["txBytes"], "65576")

    def test_payload_minimum_rejects_short_receive_or_send(self):
        for rx, tx in ((65535, 65576), (65576, 65535)):
            with self.subTest(rx=rx, tx=tx), self.assertRaises(AssertionError):
                smoke.assert_payload_bytes([{"rxBytes": str(rx), "txBytes": str(tx)}], 65536)

    def test_payload_minimum_accepts_retransmissions_in_both_directions(self):
        smoke.assert_payload_bytes([{"rxBytes": "131072", "txBytes": "196608"}], 65536)

    def test_duplicate_target_endpoints_fail(self):
        row = {"processId": 11, "connectionKey": "target", "source": "WindowsTcpEStats",
               "interfaceId": "loopback", "active": True, "appId": "python.exe"}
        with self.assertRaisesRegex(AssertionError, "端点重复"):
            smoke.capture_samples({"samples": [row, dict(row)]}, {11}, {11: "target"},
                                  "WindowsTcpEStats", True)

    def test_etw_duplicate_without_connection_key_cannot_be_filtered_away(self):
        row = {"processId": 11, "source": "WindowsEtw", "rxBytes": "65536"}
        with self.assertRaisesRegex(AssertionError, "错误来源或重复采样"):
            smoke.capture_samples({"samples": [row]}, {11}, {11: "target"},
                                  "WindowsTcpEStats", True)

    def test_etw_selection_still_uses_process_identity(self):
        rows = [{"processId": 11}, {"processId": 22}]
        self.assertEqual(smoke.target_samples({"samples": rows}, {11}, None), rows[:1])

    def test_endpoint_keys_match_native_ipv4_and_ipv6_encoding(self):
        self.assertEqual(smoke.connection_key(("127.0.0.1", 54444), ("127.0.0.1", 54445)),
                         "9:127.0.0.1:54444>9:127.0.0.1:54445")
        self.assertEqual(smoke.connection_key(("::1", 50000, 0, 0), ("::1", 50001, 0, 0)),
                         "3:::1:50000>3:::1:50001")

    def test_address_enumeration_uses_host_pwsh(self):
        output = subprocess.CompletedProcess([], 0, stdout='[{"IPAddress":"127.0.0.1","InterfaceIndex":1}]')
        with patch.object(smoke.shutil, "which", return_value="C:/Program Files/PowerShell/7/pwsh.exe"), \
                patch.object(smoke.subprocess, "CREATE_NO_WINDOW", 0, create=True), \
                patch.object(smoke.subprocess, "run", return_value=output) as run:
            with self.assertRaisesRegex(AssertionError, "ETW"):
                smoke.local_addresses()
        self.assertEqual(run.call_args.args[0][0], "C:/Program Files/PowerShell/7/pwsh.exe")
        self.assertEqual(run.call_args.kwargs["timeout"], 30)

    def test_address_enumeration_preserves_ipv6_scope_and_fallback_shell(self):
        output = subprocess.CompletedProcess([], 0, stdout='{"IPAddress":"fe80::1234%7","InterfaceIndex":7}')
        with patch.object(smoke.shutil, "which", return_value=None), \
                patch.object(smoke.subprocess, "CREATE_NO_WINDOW", 0, create=True), \
                patch.object(smoke.subprocess, "run", return_value=output) as run, \
                patch.object(smoke.socket, "socket") as socket_factory:
            self.assertEqual(smoke.local_addresses()[socket.AF_INET6], [("fe80::1234", 7)])
        self.assertEqual(run.call_args.args[0][0], "powershell.exe")
        socket_factory.return_value.__enter__.return_value.bind.assert_called_once_with(("fe80::1234", 0, 0, 7))

    def test_no_nonloopback_address_fails_instead_of_skipping_etw(self):
        output = subprocess.CompletedProcess([], 0, stdout='[{"IPAddress":"127.0.0.1","InterfaceIndex":1},{"IPAddress":"::1","InterfaceIndex":1}]')
        with patch.object(smoke.subprocess, "CREATE_NO_WINDOW", 0, create=True), patch.object(smoke.subprocess, "run", return_value=output):
            with self.assertRaisesRegex(AssertionError, "ETW"):
                smoke.local_addresses()

    def test_connections_wait_for_warmup_and_remain_open_until_release(self):
        for family, address in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
            with self.subTest(address=address):
                context = multiprocessing.get_context("spawn")
                ready, connected, done = context.Queue(), context.Queue(), context.Queue()
                transmit, release = context.Event(), context.Event()
                children = []
                try:
                    serving = context.Process(target=smoke.server, args=(family, address, 0, False, ready, connected, transmit, done, release))
                    serving.start()
                    children.append(serving)
                    port = ready.get(timeout=15)
                    sending = context.Process(target=smoke.client, args=(family, address, 0, False, port, connected, transmit, done, release))
                    sending.start()
                    children.append(sending)
                    identities = dict(connected.get(timeout=15) for _ in range(2))
                    self.assertEqual(set(identities), {serving.pid, sending.pid})
                    server_key = identities[serving.pid]
                    client_key = identities[sending.pid]
                    self.assertEqual(server_key.split(">"), list(reversed(client_key.split(">"))))
                    self.assertIn(f":{port}>", server_key)
                    with self.assertRaises(queue.Empty):
                        done.get(timeout=0.2)
                    transmit.set()
                    self.assertEqual({done.get(timeout=15), done.get(timeout=15)}, {serving.pid, sending.pid})
                    self.assertTrue(all(child.is_alive() for child in children))
                    release.set()
                    for child in children:
                        child.join(timeout=10)
                        self.assertEqual(child.exitcode, 0)
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


if __name__ == "__main__":
    unittest.main()
