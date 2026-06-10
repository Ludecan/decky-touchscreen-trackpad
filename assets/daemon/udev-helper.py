#!/usr/bin/python3
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

RULE_CONTENT = """# Touchscreen Trackpad installer-managed permissions
SUBSYSTEM=="input", KERNEL=="event*", ENV{ID_INPUT_TOUCHSCREEN}=="1", SYMLINK+="input/touchscreen-trackpad", TAG+="uaccess"
KERNEL=="uinput", TAG+="uaccess"
"""


def _run_udevadm(*args: str) -> None:
    if shutil.which("udevadm") is None:
        return

    completed = subprocess.run(["udevadm", *args], capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise RuntimeError(
            completed.stderr.strip() or completed.stdout.strip() or f"udevadm {' '.join(args)} failed"
        )


def _reload_rules() -> None:
    _run_udevadm("control", "--reload-rules")
    _run_udevadm("trigger", "--subsystem-match=input")


def install(source_path: Path, target_path: Path) -> str:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_path, target_path)
    os.chmod(target_path, 0o644)
    _reload_rules()
    return f"Installed udev rule: {target_path}"


def uninstall(target_path: Path) -> str:
    try:
        target_path.unlink()
    except FileNotFoundError:
        pass
    _reload_rules()
    return f"Removed udev rule: {target_path}"


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("Usage: udev-helper.py <install|uninstall> [source] [target]", file=sys.stderr)
        return 2

    action = argv[1]
    try:
        if action == "install":
            if len(argv) != 4:
                raise ValueError("install requires a source file and target path")
            print(install(Path(argv[2]), Path(argv[3])))
            return 0
        if action == "uninstall":
            if len(argv) != 3:
                raise ValueError("uninstall requires a target path")
            print(uninstall(Path(argv[2])))
            return 0
        raise ValueError(f"Unknown action: {action}")
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
