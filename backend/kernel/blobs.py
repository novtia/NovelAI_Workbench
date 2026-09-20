from __future__ import annotations

import io
from pathlib import Path

from PIL import Image

from kernel.hashes import sha256_bytes


class BlobStore:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def path_for(self, digest: str) -> Path:
        digest = digest.lower()
        folder = self.root / digest[:2]
        return folder / digest

    def put(self, data: bytes) -> str:
        digest = sha256_bytes(data)
        path = self.path_for(digest)
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        return digest

    def get(self, digest: str) -> bytes | None:
        path = self.path_for(digest)
        if not path.is_file():
            return None
        return path.read_bytes()

    def exists(self, digest: str) -> bool:
        return self.path_for(digest).is_file()

    def verify(self, digest: str) -> bool:
        data = self.get(digest)
        if data is None:
            return False
        return sha256_bytes(data) == digest.lower()

    def iter_hashes(self):
        if not self.root.is_dir():
            return
        for path in self.root.rglob("*"):
            if path.is_file() and len(path.name) == 64:
                yield path.name


def png_size(data: bytes) -> tuple[int, int] | None:
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def sniff_mime(data: bytes) -> str:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:2] == b"\xff\xd8":
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return "application/octet-stream"


def make_thumb(data: bytes, max_size: int = 420) -> bytes | None:
    try:
        image = Image.open(io.BytesIO(data))
        image.thumbnail((max_size, max_size))
        if image.mode not in ("RGB", "RGBA"):
            image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
        out = io.BytesIO()
        image.save(out, format="WEBP", quality=82, method=4)
        return out.getvalue()
    except Exception:
        return None
