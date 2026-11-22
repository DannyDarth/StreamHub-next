#!/usr/bin/env python3
"""
Build StreamHub's bundled Streamlink Twitch plugin.

1. Download the pinned streamlink-ttvlol release (playlist proxies for ad-free Twitch streams)
2. Verify its SHA-256 checksum
3. Apply StreamHub's patch (optional ad-free backup stream during ad breaks; a failing HTTP proxy
   moves on to the next proxy instead of stopping)
4. Copy the plugin's license next to it

Usage: build_plugin.py OUTPUT_DIR  (StreamHub builds into src-tauri/resources/streamlink-plugins)
"""

import hashlib
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path


TTVLOL_VERSION = "8.3.0-20260701"
TTVLOL_SHA256 = "4d465380159ec59f7caef6cb6a28368bbbbd3abcf80886138182184c30f2fad0"
TTVLOL_URL = f"https://github.com/2bc4/streamlink-ttvlol/releases/download/{TTVLOL_VERSION}/twitch.py"

HERE = Path(__file__).resolve().parent
PATCH = HERE / "streamhub-backup-stream.patch"
LICENSE = HERE / "LICENSE-streamlink-ttvlol.txt"


def main(output_dir: str) -> None:
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        plugin = Path(tmp) / "twitch.py"
        with urllib.request.urlopen(TTVLOL_URL, timeout=60) as res:
            data = res.read()

        digest = hashlib.sha256(data).hexdigest()
        if digest != TTVLOL_SHA256:
            sys.exit(f"streamlink-ttvlol checksum mismatch: {digest}")
        plugin.write_bytes(data)

        # the temp dir isn't a git repository, so `git apply` works like a plain `patch`
        subprocess.run(["git", "apply", "--verbose", str(PATCH)], cwd=tmp, check=True)

        shutil.copyfile(plugin, out / "twitch.py")

    shutil.copyfile(LICENSE, out / LICENSE.name)
    print(f"Built streamlink-ttvlol {TTVLOL_VERSION} + StreamHub patch into {out}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
