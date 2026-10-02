"""无管理员权限验证原生测试的握手与必需 ETW 覆盖规则。"""
import multiprocessing
import queue
import socket
import subprocess
import unittest
from unittest.mock import patch

import windows_app_capture_smoke as smoke


class NativeSmokeHarnessTest(unittest.TestCase):
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
                    self.assertEqual({connected.get(timeout=15), connected.get(timeout=15)}, {serving.pid, sending.pid})
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
