import asyncio
import json
import os
import socket
import stat
import subprocess
import shutil
import tempfile
import traceback
from pathlib import Path
from datetime import datetime, timezone

import tomllib

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
        self.log_dir = Path(os.environ.get("TOUCHSCREEN_TRACKPAD_LOG_DIR", Path.home() / ".local/state/touchscreen-trackpad"))
        self.plugin_log_path = Path(os.environ.get("TOUCHSCREEN_TRACKPAD_PLUGIN_LOG_FILE", self.log_dir / "plugin.log"))
        self.socket_timeout = float(os.environ.get("TOUCHSCREEN_TRACKPAD_SOCKET_TIMEOUT", "2.0"))
        self.socket_candidates = [
            os.environ.get("TOUCHSCREEN_TRACKPAD_SOCKET"),
            "/tmp/touchscreen-trackpad.sock",
            "/run/touchscreen-trackpad.sock",
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
            "motion": {"sensitivity": 100, "accel_strength": 0.4, "accel_exponent": 1.8, "smoothing": 0.1, "deadzone": 0.0},
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

    def _bundle_udev_helper_path(self):
        return self._daemon_assets_dir() / "udev-helper.py"

    def _ensure_log_dir(self):
        self.log_dir.mkdir(parents=True, exist_ok=True)

    def _append_plugin_log(self, level, message):
        self._ensure_log_dir()
        timestamp = datetime.now(timezone.utc).isoformat()
        with self.plugin_log_path.open("a", encoding="utf-8") as handle:
            handle.write(f"{timestamp} {level.upper()} {message}\n")

    def _log_exception(self, context, error):
        message = f"{context}: {error}"
        decky.logger.error(message)
        self._append_plugin_log("error", message)
        traceback_text = traceback.format_exc().strip()
        if traceback_text and traceback_text != "NoneType: None":
            self._append_plugin_log("error", traceback_text)

    def _format_subprocess_error(self, command, completed, headline):
        command_text = " ".join(map(str, command))
        parts = [headline, f"Command: {command_text}", f"Exit code: {completed.returncode}"]

        stdout = completed.stdout.strip()
        stderr = completed.stderr.strip()

        if stdout:
            parts.append(f"Stdout:\n{stdout}")
        if stderr:
            parts.append(f"Stderr:\n{stderr}")

        return "\n".join(parts)

    def _bundle_config_path(self):
        return self.plugin_root / "assets" / "config.toml"

    def _config_file_path(self):
        return self.install_root / "config.toml"

    def _toml_scalar(self, value):
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, (int, float)):
            return repr(value)
        return json.dumps(value)

    def _serialize_config(self, config):
        sections = ["global", "region", "motion", "inertia"]
        lines = []

        for section in sections:
            section_values = config.get(section, {}) if isinstance(config, dict) else {}
            lines.append(f"[{section}]")
            for key, value in section_values.items():
                lines.append(f"{key} = {self._toml_scalar(value)}")
            lines.append("")

        return "\n".join(lines).rstrip() + "\n"

    def _read_config_file(self):
        for path in (self._config_file_path(), self._bundle_config_path()):
            if not path.exists():
                continue

            try:
                with path.open("rb") as handle:
                    loaded = tomllib.load(handle)
                if isinstance(loaded, dict):
                    return _deep_merge(self.default_config, loaded)
            except Exception as error:
                decky.logger.warning(f"Failed to read config from {path}: {error}")

        return dict(self.default_config)

    def _write_config_file(self, config):
        self.install_root.mkdir(parents=True, exist_ok=True)
        self._config_file_path().write_text(self._serialize_config(config), encoding="utf-8")

    def _subprocess_env(self):
        env = os.environ.copy()
        env.pop("LD_LIBRARY_PATH", None)
        env.pop("LD_PRELOAD", None)
        env.pop("PYTHONHOME", None)
        env.pop("PYTHONPATH", None)

        runtime_dir = env.get("XDG_RUNTIME_DIR")
        if not runtime_dir:
            runtime_dir = f"/run/user/{os.getuid()}"
            if Path(runtime_dir).exists():
                env["XDG_RUNTIME_DIR"] = runtime_dir

        if "DBUS_SESSION_BUS_ADDRESS" not in env and runtime_dir:
            bus_path = Path(runtime_dir) / "bus"
            if bus_path.exists():
                env["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={bus_path}"

        return env

    def _service_command(self, action):
        scope = self.systemctl_scope if self.systemctl_scope in {"user", "system"} else "user"
        return ["systemctl", f"--{scope}", action, self.service_name]

    def _run_systemctl(self, *args):
        scope = self.systemctl_scope if self.systemctl_scope in {"user", "system"} else "user"
        command = ["systemctl", f"--{scope}", *args]

        completed = subprocess.run(command, capture_output=True, text=True, env=self._subprocess_env(), check=False)
        if completed.returncode != 0:
            stderr = completed.stderr.strip() or completed.stdout.strip() or "systemctl command failed"
            raise RuntimeError(stderr)

        return {"ok": True, "stdout": completed.stdout.strip(), "stderr": completed.stderr.strip()}

    def _daemon_bundle_ready(self):
        return (
            self._bundle_binary_path().exists()
            and self._bundle_installer_path().exists()
            and self._bundle_uninstaller_path().exists()
            and self._bundle_udev_helper_path().exists()
        )

    def _run_authorized_udev_helper(self, action, *args, auth_password=""):
        helper = self._bundle_udev_helper_path()
        if not helper.exists():
            raise RuntimeError(f"Bundled udev helper is missing at {helper}. Rebuild the plugin after packaging the helper.")

        python = shutil.which("python3") or "/usr/bin/python3"
        if not auth_password:
            raise RuntimeError(
                "Authorization is required to manage udev rules. Enter your sudo password in the plugin."
            )

        command = ["sudo", "-S", "-p", "", python, str(helper), action, *[str(arg) for arg in args]]
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            input=f"{auth_password}\n",
            env=self._subprocess_env(),
            check=False,
        )

        if completed.returncode != 0:
            raise RuntimeError(
                self._format_subprocess_error(command, completed, f"Udev helper {action} failed")
            )

        return completed

    def _daemon_installed(self):
        return self.install_binary.exists() and self.user_unit_path.exists() and self.udev_rule_path.exists()

    def _install_daemon(self, auth_password=""):
        binary = self._bundle_binary_path()
        if not binary.exists():
            raise RuntimeError(
                f"Bundled daemon binary is missing at {binary}. Rebuild the plugin after packaging the daemon binary."
            )

        if not os.access(binary, os.X_OK):
            raise RuntimeError(f"Bundled daemon binary is not executable: {binary}")

        config_source = self.plugin_root / "assets" / "config.toml"
        install_config = self.install_root / "config.toml"
        log_dir = self.log_dir
        log_file = self.plugin_log_path.parent / "daemon.log"
        temp_binary = None

        self.install_root.mkdir(parents=True, exist_ok=True)
        self._ensure_log_dir()

        if self._service_active():
            subprocess.run(self._service_command("stop"), capture_output=True, text=True, env=self._subprocess_env(), check=False)

        if config_source.exists():
            install_config.write_text(config_source.read_text(encoding="utf-8"), encoding="utf-8")
        else:
            install_config.write_text(
                """[global]\nenabled = true\n\n[region]\nx_min = 0.5\nx_max = 1.0\ny_min = 0.0\ny_max = 1.0\n\n[motion]\nsensitivity = 1.0\naccel_strength = 0.4\naccel_exponent = 1.8\nsmoothing = 0.1\ndeadzone = 0.0\n\n[inertia]\nenabled = true\nfriction = 0.92\ncutoff = 0.01\n""",
                encoding="utf-8",
            )

        try:
            with tempfile.NamedTemporaryFile(prefix=".touchscreen-trackpad.", dir=self.install_root, delete=False) as handle:
                temp_binary = Path(handle.name)
            shutil.copy2(binary, temp_binary)
            temp_binary.chmod(0o755)
            os.replace(temp_binary, self.install_binary)
            temp_binary = None

            log_dir.mkdir(parents=True, exist_ok=True)
            log_file.touch(exist_ok=True)

            user_unit_dir = self.user_unit_path.parent
            user_unit_dir.mkdir(parents=True, exist_ok=True)
            unit_contents = "\n".join(
                [
                    "[Unit]",
                    "Description=Touchscreen Trackpad daemon",
                    "After=graphical-session.target",
                    "",
                    "[Service]",
                    "Type=simple",
                    f"ExecStart={self.install_binary} {install_config}",
                    f"Environment=TOUCHSCREEN_TRACKPAD_SOCKET={self._resolve_socket_path()}",
                    f"Environment=RUST_LOG={os.environ.get('RUST_LOG', 'info')}",
                    f"StandardOutput=append:{log_file}",
                    f"StandardError=append:{log_file}",
                    "Restart=on-failure",
                    "RestartSec=2",
                    "",
                    "[Install]",
                    "WantedBy=default.target",
                    "",
                ]
            )
            self.user_unit_path.write_text(unit_contents, encoding="utf-8")

            rule_contents = "\n".join(
                [
                    "# Touchscreen Trackpad installer-managed permissions",
                    'SUBSYSTEM=="input", KERNEL=="event*", ENV{ID_INPUT_TOUCHSCREEN}=="1", SYMLINK+="input/touchscreen-trackpad", TAG+="uaccess"',
                    'KERNEL=="uinput", TAG+="uaccess"',
                    "",
                ]
            )
            rule_file = Path(tempfile.mkstemp(prefix="touchscreen-trackpad-rule.")[1])
            try:
                rule_file.write_text(rule_contents, encoding="utf-8")
                self._run_authorized_udev_helper("install", rule_file, self.udev_rule_path, auth_password=auth_password)
            finally:
                try:
                    rule_file.unlink(missing_ok=True)
                except Exception:
                    pass

            subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True, text=True, env=self._subprocess_env(), check=False)
            completed = subprocess.run(["systemctl", "--user", "enable", "--now", self.service_name], capture_output=True, text=True, env=self._subprocess_env(), check=False)
            if completed.returncode != 0:
                raise RuntimeError(
                    self._format_subprocess_error(["systemctl", "--user", "enable", "--now", self.service_name], completed, "Failed to enable daemon")
                )
        finally:
            if temp_binary is not None:
                try:
                    temp_binary.unlink(missing_ok=True)
                except Exception:
                    pass

        return {"ok": True, "stdout": f"Installed and started {self.service_name}", "stderr": ""}

    def _uninstall_daemon(self, auth_password=""):
        if self._service_control_ready():
            subprocess.run(self._service_command("stop"), capture_output=True, text=True, env=self._subprocess_env(), check=False)

        subprocess.run(["systemctl", "--user", "disable", self.service_name], capture_output=True, text=True, env=self._subprocess_env(), check=False)
        subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True, text=True, env=self._subprocess_env(), check=False)

        self.user_unit_path.unlink(missing_ok=True)
        self.install_binary.unlink(missing_ok=True)
        (self.install_root / "config.toml").unlink(missing_ok=True)
        shutil.rmtree(self.install_root, ignore_errors=True)
        self.plugin_log_path.unlink(missing_ok=True)
        try:
            self.log_dir.rmdir()
        except OSError:
            pass

        self._run_authorized_udev_helper("uninstall", self.udev_rule_path, auth_password=auth_password)

        return {"ok": True, "stdout": f"Uninstalled {self.service_name}", "stderr": ""}

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

    def _read_service_status(self):
        completed = subprocess.run(
            ["systemctl", f"--{self.systemctl_scope}", "show", self.service_name, "--property=ActiveState", "--property=SubState", "--property=UnitFileState"],
            capture_output=True,
            text=True,
            env=self._subprocess_env(),
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
        completed = subprocess.run(command, capture_output=True, text=True, env=self._subprocess_env(), check=False)
        return completed.returncode in (0, 3)

    def _service_active(self):
        completed = subprocess.run(["systemctl", f"--{self.systemctl_scope}", "is-active", self.service_name], capture_output=True, text=True, env=self._subprocess_env(), check=False)
        return completed.returncode == 0

    async def get_state(self):
        service_active = self._service_active()
        service_status = self._read_service_status()
        return {
            "connected": service_active,
            "service_active": service_active,
            "service_status": service_status,
            "service_control_ready": self._service_control_ready(),
            "socket_path": self._resolve_socket_path(),
            "daemon_bundle_ready": self._daemon_bundle_ready(),
            "daemon_installed": self._daemon_installed(),
            "config": self._read_config_file(),
        }

    async def set_config(self, patch):
        try:
            current_config = self._read_config_file()
            merged_config = _deep_merge(current_config, patch)
            await asyncio.to_thread(self._write_config_file, merged_config)
            return await self.get_state()
        except Exception as error:
            self._log_exception("Failed to update config", error)
            raise

    async def install_daemon(self, auth_password=""):
        try:
            await asyncio.to_thread(self._install_daemon, auth_password)
            return await self.get_state()
        except Exception as error:
            self._log_exception("Failed to install daemon", error)
            raise

    async def uninstall_daemon(self, auth_password=""):
        try:
            await asyncio.to_thread(self._uninstall_daemon, auth_password)
            return await self.get_state()
        except Exception as error:
            self._log_exception("Failed to uninstall daemon", error)
            raise

    async def start_daemon(self):
        try:
            await asyncio.to_thread(self._run_systemctl, "start", self.service_name)
            return await self.get_state()
        except Exception as error:
            self._log_exception("Failed to start daemon", error)
            raise

    async def stop_daemon(self):
        try:
            await asyncio.to_thread(self._run_systemctl, "stop", self.service_name)
            return await self.get_state()
        except Exception as error:
            self._log_exception("Failed to stop daemon", error)
            raise

    async def restart_daemon(self):
        try:
            await asyncio.to_thread(self._run_systemctl, "restart", self.service_name)
            return await self.get_state()
        except Exception as error:
            self._log_exception("Failed to restart daemon", error)
            raise

    async def repair_daemon(self):
        try:
            await asyncio.to_thread(self._install_daemon)
            return await self.get_state()
        except Exception as error:
            self._log_exception("Failed to repair daemon", error)
            raise

    async def _main(self):
        self.loop = asyncio.get_event_loop()
        decky.logger.info("Touchscreen Trackpad backend loaded")

    async def _unload(self):
        decky.logger.info("Touchscreen Trackpad backend unloaded")

    async def _uninstall(self):
        decky.logger.info("Touchscreen Trackpad backend uninstall hook")
