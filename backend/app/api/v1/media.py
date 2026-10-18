# backend/app/api/v1/media.py

import asyncio
import logging
import os
import re
import time
from urllib.parse import quote
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response, StreamingResponse

from app.api.dependencies import get_current_user
from app.core import rate_limit as rl
from app.models.user import User
from app.services import media_crypto, media_processing, media_storage

router = APIRouter(prefix="/media", tags=["Media"])
logger = logging.getLogger(__name__)

CHUNK_SIZE = 1024 * 1024
_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


@router.post("/upload")
async def upload_media(
    file: UploadFile = File(...),
    quality: str = Query("standard", pattern="^(standard|hd|original)$"),
    encrypted: bool = Query(False, description="End-to-end encrypted by the app: stored as opaque bytes"),
    kind: Optional[str] = Query(None, pattern="^(image|video|audio|file|backup)$", description="With encrypted: what it is, for the size limit"),
    current_user: User = Depends(get_current_user),
):
    """
    Store an image, video, voice note or document and return its URL for use in a message.

    quality: standard = videos compressed to 720p; hd = videos kept as sent;
    original = sent as a document, nothing changed except removing photo metadata.
    Photos always lose their metadata (location etc.). Files are encrypted on disk.

    encrypted=true: the app already encrypted the file end to end (and removed photo metadata
    itself). The server can't look inside, so it stores the bytes as they are: no type check,
    compression or poster frame.
    """
    await rl.enforce((rl.UPLOADS_PER_USER, str(current_user.id)))
    if encrypted:
        if not kind:
            raise HTTPException(status_code=400, detail="Say what kind of file this is")
        media_type, extension, mime = kind, media_storage.ENCRYPTED_EXTENSION, "application/octet-stream"
        # 16-byte header plus a 16-byte tag per 64 KiB chunk
        plain_max = media_storage.max_size_for(media_type)
        max_size = plain_max + 16 + 16 * (plain_max // (64 * 1024) + 1)
        head = await file.read(16)
    else:
        mime = media_storage.clean_mime((file.content_type or "").split(";")[0].strip().lower())
        media_type, extension = media_storage.file_type_for(mime)
        max_size = media_storage.max_size_for(media_type)

        head = await file.read(16)
        # Photos, videos and the listed documents must be what they say (they're shown or opened
        # in place); anything else is only ever downloaded, so it isn't checked
        if mime in media_storage.ALLOWED_TYPES and not media_storage.content_matches(mime, head):
            raise HTTPException(status_code=415, detail="File content does not match its type")

    key = media_storage.new_key(extension)
    path = media_storage.path_for_key(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    work = path.with_name(path.name + ".upload")  # plaintext only while we process it

    size = len(head)
    width = height = None
    duration = None
    poster_key = None
    try:
        with open(work, "wb") as out:
            out.write(head)
            while chunk := await file.read(CHUNK_SIZE):
                size += len(chunk)
                if size > max_size:
                    raise HTTPException(
                        status_code=413,
                        detail=f"File too large (max {max_size // (1024 * 1024)}MB for {media_type}s)",
                    )
                out.write(chunk)

        if encrypted:
            pass  # opaque: nothing to clean up or compress
        elif media_type == "image":
            try:
                dims = await asyncio.to_thread(media_processing.clean_image, work, mime, quality == "original")
                width, height = dims if dims else (None, None)
            except Exception:
                raise HTTPException(status_code=415, detail="This image couldn't be read")
        elif media_type == "video" and quality == "standard":
            compressed = work.with_name(work.name + ".mp4")
            if await media_processing.compress_video(work, compressed):
                os.replace(compressed, work)
                if extension != ".mp4":  # now an MP4 whatever was sent
                    mime, extension = "video/mp4", ".mp4"
                    path.unlink(missing_ok=True)
                    key = key.rsplit(".", 1)[0] + extension
                    path = media_storage.path_for_key(key)

        if media_type == "video" and not encrypted:
            # Poster frame for previews; the video still uploads fine if this fails
            poster = work.with_name(work.name + ".jpg")
            try:
                info = await media_processing.video_poster(work, poster)
                if info:
                    width, height, duration = info
                    poster_key = media_storage.new_key(".jpg")
                    poster_path = media_storage.path_for_key(poster_key)
                    poster_path.parent.mkdir(parents=True, exist_ok=True)
                    await asyncio.to_thread(media_crypto.encrypt_file, poster, poster_path)
            except Exception:
                logger.warning("Couldn't make a video poster", exc_info=True)
                poster_key = None
            finally:
                poster.unlink(missing_ok=True)

        size = await asyncio.to_thread(media_crypto.encrypt_file, work, path)
    except BaseException:
        path.unlink(missing_ok=True)
        if poster_key:
            media_storage.path_for_key(poster_key).unlink(missing_ok=True)
        raise
    finally:
        work.unlink(missing_ok=True)

    # (encrypted: the real name travels inside the encrypted message)
    name = f"file{extension}" if encrypted else os.path.basename(file.filename or "")[:255] or f"file{extension}"
    if not name.lower().endswith(extension) and media_type == "video":
        name = name.rsplit(".", 1)[0] + extension
    return {
        "success": True,
        "message": "File uploaded successfully",
        "data": {
            # Plain URL: send this back in messages / profile / group updates
            "url": media_storage.MEDIA_URL_PREFIX + key,
            # Signed URL: use this to display the file right away
            "signedUrl": media_storage.sign_url(media_storage.MEDIA_URL_PREFIX + key),
            "mediaType": media_type,
            "mimeType": mime,
            "size": size,
            "filename": name,
            "width": width,
            "height": height,
            # Videos: a server-made poster frame and the length in seconds (null if unavailable)
            "thumbnailUrl": media_storage.MEDIA_URL_PREFIX + poster_key if poster_key else None,
            "thumbnailSignedUrl": media_storage.sign_url(media_storage.MEDIA_URL_PREFIX + poster_key) if poster_key else None,
            "duration": round(duration, 1) if duration else None,
        },
    }


@router.get("/{key:path}")
async def get_media(
    key: str,
    request: Request,
    exp: Optional[str] = Query(None),
    sig: Optional[str] = Query(None),
    download: bool = Query(False),
    name: Optional[str] = Query(None, max_length=255),
):
    """
    Serve an uploaded file. Needs the signature from a signed URL (see media_storage.sign_url).
    Supports Range requests so videos can seek; only the needed chunks are decrypted.
    """
    if not media_storage.verify_signature(key, exp, sig):
        raise HTTPException(status_code=403, detail="Media link expired or invalid")

    path = media_storage.path_for_key(key)
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="Media not found")

    mime = media_storage.EXTENSION_MIME.get(path.suffix, "application/octet-stream")
    file_size = media_crypto.plain_size(path)
    headers = {
        "Accept-Ranges": "bytes",
        # Cache only as long as the link is valid
        "Cache-Control": f"private, max-age={max(int(exp) - int(time.time()), 0)}",
        "X-Content-Type-Options": "nosniff",
        # The same file is loaded by <img>/<video> (no Origin) and by fetch() for decryption (CORS):
        # without this a browser can reuse the first, header-less response for the second and block it
        "Vary": "Origin",
    }
    if download:
        # Save to disk under the original name (?download=1&name=holiday.jpg)
        safe = re.sub(r"[\x00-\x1f\x7f/\\\\]", "", os.path.basename(name or "")).strip() or f"download{path.suffix}"
        headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{quote(safe[:150])}"
    elif not mime.startswith(("image/", "video/", "audio/")):
        headers["Content-Disposition"] = "attachment"

    range_header = request.headers.get("range")
    if not range_header:
        headers["Content-Length"] = str(file_size)
        return StreamingResponse(media_crypto.iter_plaintext(path, 0, file_size), media_type=mime, headers=headers)

    match = _RANGE_RE.match(range_header.strip())
    if not match or (not match.group(1) and not match.group(2)):
        return Response(status_code=416, headers={"Content-Range": f"bytes */{file_size}"})

    if match.group(1):
        start = int(match.group(1))
        end = int(match.group(2)) if match.group(2) else file_size - 1
    else:  # suffix range: last N bytes
        start = max(file_size - int(match.group(2)), 0)
        end = file_size - 1
    end = min(end, file_size - 1)

    if start > end or start >= file_size:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{file_size}"})

    length = end - start + 1
    headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
    headers["Content-Length"] = str(length)
    return StreamingResponse(
        media_crypto.iter_plaintext(path, start, length), status_code=206, media_type=mime, headers=headers
    )
