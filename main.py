import asyncio
import json
import os
import socket
import stat
import subprocess
from pathlib import Path

import decky


def _deep_merge(base, patch):
    merged = dict(base)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


class Plugin:
    def __init__(self):
        self.loop = None
        self.plugin_root = Path(__file__).resolve().parent
        self.socket_timeout = float(os.environ.get("TOUCHSCREEN_TRACKPAD_SOCKET_TIMEOUT", "2.0"))
        self.socket_candidates = [
            os.environ.get("TOUCHSCREEN_TRACKPAD_SOCKET"),
            "/run/touchscreen-trackpad.sock",
            "/tmp/touchscreen-trackpad.sock",
        ]
        self.service_name = os.environ.get("TOUCHSCREEN_TRACKPAD_SERVICE", "touchscreen-trackpad.service")
        self.systemctl_scope = os.environ.get("TOUCHSCREEN_TRACKPAD_SYSTEMCTL_SCOPE", "user")
        self.install_root = Path.home() / ".local/share/touchscreen-trackpad"
        self.install_binary = self.install_root / "touchscreen-trackpad"
        self.user_unit_path = Path.home() / ".config/systemd/user" / self.service_name
        self.udev_rule_path = Path("/etc/udev/rules.d/99-touchscreen-trackpad.rules")
        self.default_config = {
            "global": {"enabled": True},
            "region": {"x_min": 0.5, "x_max": 1.0, "y_min": 0.0, "y_max": 1.0},
            "motion": {"sensitivity": 1.0, "accel_strength": 0.4, "smoothing": 0.1, "deadzone": 0.0},
            "inertia": {"enabled": True, "friction": 0.92, "cutoff": 0.01},
        }

    def _daemon_assets_dir(self):
        return self.plugin_root / "assets" / "daemon"

    def _bundle_binary_path(self):
        return self._daemon_assets_dir() / "touchscreen-trackpad"

    def _bundle_installer_path(self):
        return self._daemon_assets_dir() / "install-daemon.sh"

    def _bundle_uninstaller_path(self):
        return self._daemon_assets_dir() / "uninstall-daemon.sh"

    def _service_command(self, action):
        scope = self.systemctl_scope if self.systemctl_scope in {"user", "system"} else "user"
        return ["systemctl", f"--{scope}", action, self.service_name]

    def _run_systemctl(self, *args):
        scope = self.systemctl_scope if self.systemctl_scope in {"user", "system"} else "user"
        command = ["systemctl", f"--{scope}", *args]

        completed = subprocess.run(command, capture_output=True, text=True, check=False)
        if completed.returncode != 0:
            stderr = completed.stderr.strip() or completed.stdout.strip() or "systemctl command failed"
            raise RuntimeError(stderr)

        return {"ok": True, "stdout": completed.stdout.strip(), "stderr": completed.stderr.strip()}

    def _daemon_bundle_ready(self):
        return (
            self._bundle_binary_path().exists()
            and self._bundle_installer_path().exists()
            and self._bundle_uninstaller_path().exists()
        )

    def _daemon_installed(self):
        return self.install_binary.exists() and self.user_unit_path.exists() and self.udev_rule_path.exists()

    def _install_daemon(self):
        installer = self._bundle_installer_path()
        binary = self._bundle_binary_path()
        if not installer.exists():
            raise RuntimeError(
                f"Bundled daemon installer is missing at {installer}. Rebuild the plugin after packaging the daemon scripts."
            )
        if not binary.exists():
            raise RuntimeError(
                f"Bundled daemon binary is missing at {binary}. Rebuild the plugin after packaging the daemon binary."
            )

        completed = subprocess.run(
            [str(installer), str(binary)],
            capture_output=True,
            text=True,
            check=False,
        )
        if completed.returncode != 0:
            stderr = completed.stderr.strip() or completed.stdout.strip() or "daemon install failed"
            raise RuntimeError(stderr)

        return {"ok": True, "stdout": completed.stdout.strip(), "stderr": completed.stderr.strip()}

    def _uninstall_daemon(self):
        uninstaller = self._bundle_uninstaller_path()
        if not uninstaller.exists():
            raise RuntimeError(
                f"Bundled daemon uninstaller is missing at {uninstaller}. Rebuild the plugin after packaging the daemon scripts."
            )

        completed = subprocess.run(
            [str(uninstaller)],
            capture_output=True,
            text=True,
            check=False,
        )
        if completed.returncode != 0:
            stderr = completed.stderr.strip() or completed.stdout.strip() or "daemon uninstall failed"
            raise RuntimeError(stderr)

        return {"ok": True, "stdout": completed.stdout.strip(), "stderr": completed.stderr.strip()}

    def _resolve_socket_path(self):
        for candidate in self.socket_candidates:
            if not candidate:
                continue
            path = Path(candidate)
            if path.exists() and stat.S_ISSOCK(path.stat().st_mode):
                return str(path)

        for candidate in self.socket_candidates:
            if candidate:
                return candidate

        return "/run/touchscreen-trackpad.sock"

    def _read_response(self, client):
        buffer = b""
        while True:
            chunk = client.recv(4096)
            if not chunk:
                break
            buffer += chunk
            if b"\n" in buffer:
                break

        text = buffer.decode("utf-8", errors="replace").strip()
        if not text:
            return {"ok": True}

        line = text.splitlines()[-1]
        return json.loads(line)

    def _rpc(self, method, params=None):
        socket_path = self._resolve_socket_path()
        payload = {"method": method, "params": params or {}}

        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(self.socket_timeout)
            client.connect(socket_path)
            client.sendall((json.dumps(payload) + "\n").encode("utf-8"))
            response = self._read_response(client)

        if isinstance(response, dict) and response.get("ok") is False:
            message = response.get("error") or response.get("message") or "daemon request failed"
            raise RuntimeError(message)

        return response

    def _run_systemctl(self, action):
        command = self._service_command(action)

        completed = subprocess.run(command, capture_output=True, text=True, check=False)
        if completed.returncode != 0:
            stderr = completed.stderr.strip() or completed.stdout.strip() or f"systemctl {action} failed"
            raise RuntimeError(stderr)

        return {"ok": True, "stdout": completed.stdout.strip(), "stderr": completed.stderr.strip()}

    def _read_service_status(self):
        completed = subprocess.run(
            ["systemctl", f"--{self.systemctl_scope}", "show", self.service_name, "--property=ActiveState", "--property=SubState", "--property=UnitFileState"],
            capture_output=True,
            text=True,
            check=False,
        )

        status = {
            "active_state": "unknown",
            "sub_state": "unknown",
            "unit_file_state": "unknown",
        }

        for line in completed.stdout.splitlines():
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            if key == "ActiveState":
                status["active_state"] = value
            elif key == "SubState":
                status["sub_state"] = value
            elif key == "UnitFileState":
                status["unit_file_state"] = value

        status["query_ok"] = completed.returncode == 0
        return status

    def _service_control_ready(self):
        command = self._service_command("status")
        completed = subprocess.run(command, capture_output=True, text=True, check=False)
        return completed.returncode in (0, 3)

    def _service_active(self):
        completed = subprocess.run(["systemctl", f"--{self.systemctl_scope}", "is-active", self.service_name], capture_output=True, text=True, check=False)
        return completed.returncode == 0

    def _normalize_state(self, state):
        config = state.get("config") if isinstance(state, dict) else None
        return {
            "connected": bool(state.get("connected", True)) if isinstance(state, dict) else False,
            "service_active": self._service_active(),
            "service_status": self._read_service_status(),
            "service_control_ready": self._service_control_ready(),
            "socket_path": self._resolve_socket_path(),
            "daemon_bundle_ready": self._daemon_bundle_ready(),
            "daemon_installed": self._daemon_installed(),
            "config": config if config is not None else None,
        }

    async def get_state(self):
        try:
            response = await asyncio.to_thread(self._rpc, "config/get")
            return self._normalize_state(response)
        except Exception as error:
            decky.logger.warning(f"Unable to read daemon state: {error}")
            return {
                "connected": False,
                "service_active": self._service_active(),
                "service_status": self._read_service_status(),
                "service_control_ready": self._service_control_ready(),
                "socket_path": self._resolve_socket_path(),
                "daemon_bundle_ready": self._daemon_bundle_ready(),
                "daemon_installed": self._daemon_installed(),
                "config": None,
            }

    async def set_config(self, patch):
        response = await asyncio.to_thread(self._rpc, "config/set", patch)
        if isinstance(response, dict) and "config" in response:
            return self._normalize_state(response)

        merged = _deep_merge(self.default_config, patch)
        return {
            "connected": True,
            "service_active": self._service_active(),
            "service_status": self._read_service_status(),
            "service_control_ready": self._service_control_ready(),
            "socket_path": self._resolve_socket_path(),
            "daemon_bundle_ready": self._daemon_bundle_ready(),
            "daemon_installed": self._daemon_installed(),
            "config": merged,
        }

    async def install_daemon(self):
        await asyncio.to_thread(self._install_daemon)
        return await self.get_state()

    async def uninstall_daemon(self):
        await asyncio.to_thread(self._uninstall_daemon)
        return await self.get_state()

    async def start_daemon(self):
        await asyncio.to_thread(self._run_systemctl, "start", self.service_name)
        return await self.get_state()

    async def stop_daemon(self):
        await asyncio.to_thread(self._run_systemctl, "stop", self.service_name)
        return await self.get_state()

    async def restart_daemon(self):
        await asyncio.to_thread(self._run_systemctl, "restart", self.service_name)
        return await self.get_state()

    async def repair_daemon(self):
        await asyncio.to_thread(self._install_daemon)
        return await self.get_state()

    async def _main(self):
        self.loop = asyncio.get_event_loop()
        decky.logger.info("Touchscreen Trackpad backend loaded")

    async def _unload(self):
        decky.logger.info("Touchscreen Trackpad backend unloaded")

    async def _uninstall(self):
        decky.logger.info("Touchscreen Trackpad backend uninstall hook")
