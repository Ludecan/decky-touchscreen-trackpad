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
        self.socket_timeout = float(os.environ.get("TOUCHSCREEN_TRACKPAD_SOCKET_TIMEOUT", "2.0"))
        self.socket_candidates = [
            os.environ.get("TOUCHSCREEN_TRACKPAD_SOCKET"),
            "/run/touchscreen-trackpad.sock",
            "/tmp/touchscreen-trackpad.sock",
        ]
        self.service_name = os.environ.get("TOUCHSCREEN_TRACKPAD_SERVICE", "touchscreen-trackpad.service")
        self.default_config = {
            "global": {"enabled": True},
            "region": {"x_min": 0.5, "x_max": 1.0, "y_min": 0.0, "y_max": 1.0},
            "motion": {"sensitivity": 1.0, "accel_strength": 0.4, "smoothing": 0.1, "deadzone": 0.0},
            "inertia": {"enabled": True, "friction": 0.92, "cutoff": 0.01},
        }

    def _service_command(self, action):
        command = ["systemctl", action, self.service_name]
        if os.geteuid() != 0:
            command = ["sudo", "-n", *command]
        return command

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
            ["systemctl", "show", self.service_name, "--property=ActiveState", "--property=SubState", "--property=UnitFileState"],
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
        completed = subprocess.run(["systemctl", "is-active", self.service_name], capture_output=True, text=True, check=False)
        return completed.returncode == 0

    def _normalize_state(self, state):
        config = state.get("config") if isinstance(state, dict) else None
        return {
            "connected": bool(state.get("connected", True)) if isinstance(state, dict) else False,
            "service_active": self._service_active(),
            "service_status": self._read_service_status(),
            "service_control_ready": self._service_control_ready(),
            "socket_path": self._resolve_socket_path(),
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
            "config": merged,
        }

    async def start_daemon(self):
        await asyncio.to_thread(self._run_systemctl, "start")
        return await self.get_state()

    async def stop_daemon(self):
        await asyncio.to_thread(self._run_systemctl, "stop")
        return await self.get_state()

    async def restart_daemon(self):
        await asyncio.to_thread(self._run_systemctl, "restart")
        return await self.get_state()

    async def _main(self):
        self.loop = asyncio.get_event_loop()
        decky.logger.info("Touchscreen Trackpad backend loaded")

    async def _unload(self):
        decky.logger.info("Touchscreen Trackpad backend unloaded")

    async def _uninstall(self):
        decky.logger.info("Touchscreen Trackpad backend uninstall hook")
