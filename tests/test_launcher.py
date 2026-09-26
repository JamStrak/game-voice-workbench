import importlib.util
import json
from pathlib import Path
import tempfile
import socket
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("launcher", Path(__file__).resolve().parents[1] / "scripts/launch.py")
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        (self.root / "local_config.json").write_text('{"preferred_port":23164}', encoding="utf-8")

    def test_busy_preferred_port_uses_next_free(self):
        self.assertEqual(launcher.choose_port([23164, 23165, 23166], lambda p: p == 23166), 23166)

    def test_clean_download_can_find_existing_instance_without_local_configuration(self):
        (self.root / "local_config.json").unlink()
        self.assertEqual(launcher.candidate_ports(self.root)[0], 23164)
        info = {"app": "voice-workbench", "root": str(self.root), "pid": 9}
        with patch.object(launcher, "find_existing", return_value=(23164, info)), \
             patch.object(launcher.subprocess, "Popen") as popen:
            self.assertEqual(launcher.start(self.root), "http://127.0.0.1:23164/")
            popen.assert_not_called()
        self.assertFalse((self.root / "local_config.json").exists())

    def test_real_socket_occupation_is_detected(self):
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            self.assertFalse(launcher.port_free(occupied.getsockname()[1]))

    def test_reuse_requires_both_identity_and_root(self):
        identities = {23164: {"app": "other", "root": str(self.root)},
                      23165: {"app": "voice-workbench", "root": str(self.root / "other")},
                      23166: {"app": "voice-workbench", "root": str(self.root), "pid": 7}}
        result = launcher.find_existing(self.root, list(identities), identities.get)
        self.assertEqual(result[0], 23166)

    def test_existing_service_skips_environment_and_subprocess(self):
        info = {"app": "voice-workbench", "root": str(self.root), "pid": 9}
        with patch.object(launcher, "find_existing", return_value=(23165, info)), \
             patch.object(launcher.subprocess, "Popen") as popen:
            self.assertEqual(launcher.start(self.root), "http://127.0.0.1:23165/")
            popen.assert_not_called()
        self.assertEqual(json.loads((self.root / "data/server.json").read_text())["pid"], 9)

    def test_missing_environment_is_actionable(self):
        with patch.object(launcher, "find_existing", return_value=None):
            with self.assertRaisesRegex(launcher.LaunchError, "缺少配音环境"):
                launcher.start(self.root)

    def test_interrupted_release_install_is_not_mistaken_for_ready_environment(self):
        (self.root / "runtime/uv").mkdir(parents=True)
        (self.root / "runtime/uv/uv.exe").touch()
        (self.root / ".venv/Scripts").mkdir(parents=True)
        (self.root / ".venv/Scripts/python.exe").touch()
        with patch.object(launcher, "find_existing", return_value=None), \
             patch.object(launcher.subprocess, "Popen") as popen:
            with self.assertRaisesRegex(launcher.LaunchError, "上次安装尚未完成"):
                launcher.start(self.root)
            popen.assert_not_called()

    def test_all_ports_busy_is_actionable(self):
        with self.assertRaisesRegex(launcher.LaunchError, "均被占用"):
            launcher.choose_port([23164, 23165], lambda _: False)

    def test_saved_port_first_but_stale_outside_range_ignored(self):
        (self.root / "data").mkdir()
        record = self.root / "data/server.json"
        record.write_text('{"port":23169}')
        self.assertEqual(launcher.candidate_ports(self.root)[0], 23169)
        record.write_text('{"port":80}')
        self.assertEqual(launcher.candidate_ports(self.root)[0], 23164)

    def test_file_lock_blocks_second_launch_and_releases(self):
        with launcher.launch_lock(self.root):
            with self.assertRaisesRegex(launcher.LaunchError, "另一个启动"):
                with launcher.launch_lock(self.root, timeout=0):
                    self.fail("concurrent launcher entered lock")
        with launcher.launch_lock(self.root, timeout=0):
            pass

    def test_startup_exit_reports_log(self):
        (self.root / ".venv/Scripts").mkdir(parents=True)
        (self.root / ".venv/Scripts/python.exe").touch()
        (self.root / "scripts").mkdir()
        (self.root / "scripts/server.py").touch()
        with patch.object(launcher, "find_existing", return_value=None), \
             patch.object(launcher, "choose_port", return_value=23164), \
             patch.object(launcher.subprocess, "Popen") as popen:
            popen.return_value.poll.return_value = 2
            popen.return_value.returncode = 2
            with self.assertRaisesRegex(launcher.LaunchError, "server.log"):
                launcher.start(self.root)

    def test_startup_timeout_only_terminates_its_child(self):
        (self.root / ".venv/Scripts").mkdir(parents=True)
        (self.root / ".venv/Scripts/python.exe").touch()
        (self.root / "scripts").mkdir()
        (self.root / "scripts/server.py").touch()
        with patch.object(launcher, "find_existing", return_value=None), \
             patch.object(launcher, "choose_port", return_value=23164), \
             patch.object(launcher.subprocess, "Popen") as popen:
            with self.assertRaisesRegex(launcher.LaunchError, "仍未就绪"):
                launcher.start(self.root, timeout=0)
            popen.return_value.terminate.assert_called_once()
            popen.return_value.wait.assert_called_once()

    def test_stop_without_matching_service_sends_no_shutdown(self):
        with patch.object(launcher, "find_existing", return_value=None), \
             patch.object(launcher.OPENER, "open") as request:
            self.assertFalse(launcher.stop(self.root))
            request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
