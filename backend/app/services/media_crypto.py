# backend/app/services/media_crypto.py

"""
Encryption at rest for uploaded media (photos, videos, voice notes, files).

Files are split into 64 KiB chunks, each sealed with AES-256-GCM, so the server can
decrypt just the part a video player asks for (HTTP Range) instead of the whole file.

    header:  b"PAPYENC1" | 8-byte random nonce prefix | 8-byte plaintext size
    chunks:  AES-GCM(chunk i) = ciphertext + 16-byte tag, nonce = prefix | i (4 bytes)

The header is bound to every chunk (associated data), so chunks can't be swapped between
files or reordered. Files written before encryption existed (no magic) are served as-is;
scripts/encrypt_media.py converts them.
"""

import base64
import hashlib
import logging
import os
import struct
from pathlib import Path
from typing import Iterator

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.config.settings import settings

logger = logging.getLogger(__name__)

MAGIC = b"PAPYENC1"
HEADER_SIZE = len(MAGIC) + 8 + 8
CHUNK = 64 * 1024
TAG = 16
SEALED_CHUNK = CHUNK + TAG

_warned = False


def _derived_key() -> bytes:
    return hashlib.sha256(f"papyris-media:{settings.JWT_SECRET_KEY}".encode()).digest()


def _key() -> bytes:
    """The key new files are encrypted with."""
    global _warned
    if settings.MEDIA_ENCRYPTION_KEY:
        try:
            key = base64.urlsafe_b64decode(settings.MEDIA_ENCRYPTION_KEY + "=" * (-len(settings.MEDIA_ENCRYPTION_KEY) % 4))
            if len(key) == 32:
                return key
        except ValueError:
            pass
        raise RuntimeError("MEDIA_ENCRYPTION_KEY must be 32 bytes, base64 encoded (see README)")
    if not _warned:
        logger.warning("MEDIA_ENCRYPTION_KEY is not set; deriving the media key from JWT_SECRET_KEY")
        _warned = True
    return _derived_key()


def _keys_to_try() -> list[bytes]:
    """
    Current key first, then the JWT-derived one, so files saved before MEDIA_ENCRYPTION_KEY
    was set stay readable.
    """
    keys = [_key()]
    if settings.MEDIA_ENCRYPTION_KEY:
        keys.append(_derived_key())
    return keys


def is_encrypted(path: Path) -> bool:
    with open(path, "rb") as f:
        return f.read(len(MAGIC)) == MAGIC


def plain_size(path: Path) -> int:
    """Size of the original file (what clients see)."""
    with open(path, "rb") as f:
        header = f.read(HEADER_SIZE)
    if header[: len(MAGIC)] != MAGIC:
        return path.stat().st_size
    return struct.unpack(">Q", header[len(MAGIC) + 8 :])[0]


def _nonce(prefix: bytes, index: int) -> bytes:
    return prefix + struct.pack(">I", index)


def encrypt_file(source: Path, target: Path) -> int:
    """Encrypt `source` into `target` (may be the same path). Returns the plaintext size."""
    size = source.stat().st_size
    prefix = os.urandom(8)
    header = MAGIC + prefix + struct.pack(">Q", size)
    aead = AESGCM(_key())
    tmp = target.with_name(target.name + ".enc-tmp")
    with open(source, "rb") as src, open(tmp, "wb") as out:
        out.write(header)
        index = 0
        while chunk := src.read(CHUNK):
            out.write(aead.encrypt(_nonce(prefix, index), chunk, header))
            index += 1
    os.replace(tmp, target)
    return size


def iter_plaintext(path: Path, start: int, length: int) -> Iterator[bytes]:
    """Yield `length` bytes of the original file from offset `start`, decrypting only the chunks needed."""
    if length <= 0:
        return
    with open(path, "rb") as f:
        header = f.read(HEADER_SIZE)
        if header[: len(MAGIC)] != MAGIC:  # older, unencrypted file
            f.seek(start)
            remaining = length
            while remaining > 0:
                data = f.read(min(1024 * 1024, remaining))
                if not data:
                    return
                remaining -= len(data)
                yield data
            return
        prefix = header[len(MAGIC) : len(MAGIC) + 8]
        index = start // CHUNK
        f.seek(HEADER_SIZE + index * SEALED_CHUNK)
        aead = _opener(prefix, index, f.read(SEALED_CHUNK), header)
        offset = start - index * CHUNK
        remaining = length
        f.seek(HEADER_SIZE + index * SEALED_CHUNK)
        while remaining > 0:
            sealed = f.read(SEALED_CHUNK)
            if not sealed:
                return
            chunk = aead.decrypt(_nonce(prefix, index), sealed, header)
            piece = chunk[offset : offset + remaining]
            offset = 0
            remaining -= len(piece)
            index += 1
            yield piece


def _opener(prefix: bytes, index: int, sealed: bytes, header: bytes) -> AESGCM:
    """The AES-GCM instance whose key opens this file (checked on its first needed chunk)."""
    for key in _keys_to_try():
        aead = AESGCM(key)
        try:
            aead.decrypt(_nonce(prefix, index), sealed, header)
            return aead
        except InvalidTag:
            continue
    raise InvalidTag("No media key opens this file (was MEDIA_ENCRYPTION_KEY changed?)")


def seal(data: bytes, purpose: bytes) -> bytes:
    """Small bytes held briefly outside the uploads folder (e.g. in Redis): nonce | AES-GCM(data)."""
    nonce = os.urandom(12)
    return nonce + AESGCM(_key()).encrypt(nonce, data, purpose)


def unseal(sealed: bytes, purpose: bytes) -> bytes:
    return AESGCM(_key()).decrypt(sealed[:12], sealed[12:], purpose)


def read_all(path: Path) -> bytes:
    """The whole original file (for small things like receipt photos)."""
    return b"".join(iter_plaintext(path, 0, plain_size(path)))
