"""File storage for product images (public) and seller KYC documents (private).

Images are decoded and re-encoded to WebP, which strips metadata (EXIF/GPS) and anything that
is not pixel data. Documents are checked by magic bytes and never served publicly.
"""
from __future__ import annotations

import asyncio
import io
import uuid
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

from app.config import settings
from app.core.errors import ApiError

Image.MAX_IMAGE_PIXELS = 40_000_000
MAX_SIDE = 1600

DOC_TYPES = {
    b"%PDF-": ("application/pdf", "pdf"),
    b"\xff\xd8\xff": ("image/jpeg", "jpg"),
    b"\x89PNG\r\n\x1a\n": ("image/png", "png"),
}


def _process_image(data: bytes) -> bytes:
    try:
        with Image.open(io.BytesIO(data)) as probe:
            probe.verify()
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img)
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, SyntaxError) as exc:
        raise ApiError("This file is not a valid image", "invalid_image") from exc
    if img.width < 200 or img.height < 200:
        raise ApiError("Image must be at least 200 x 200 pixels", "image_too_small")
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[-1])
        img = bg
    else:
        img = img.convert("RGB")
    img.thumbnail((MAX_SIDE, MAX_SIDE))
    out = io.BytesIO()
    img.save(out, "WEBP", quality=85, method=4)
    return out.getvalue()


def _s3():
    import boto3  # imported lazily so local development does not need AWS credentials

    return boto3.client("s3", region_name=settings.s3_region)


async def save_image(data: bytes, folder: str) -> str:
    if len(data) > settings.max_image_bytes:
        raise ApiError(f"Image must be smaller than {settings.max_image_bytes // (1024 * 1024)} MB", "file_too_large")
    webp = await asyncio.to_thread(_process_image, data)
    key = f"{folder}/{uuid.uuid4().hex}.webp"
    if settings.storage_backend == "s3":
        await asyncio.to_thread(
            _s3().put_object,
            Bucket=settings.s3_bucket,
            Key=key,
            Body=webp,
            ContentType="image/webp",
            CacheControl="public, max-age=31536000, immutable",
        )
    else:
        path = Path(settings.media_root) / key
        path.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(path.write_bytes, webp)
    return f"{settings.media_base_url.rstrip('/')}/{key}"


def sniff_video(data: bytes) -> tuple[str, str]:
    """(content type, extension) for MP4 or WebM, by magic bytes; anything else is refused."""
    if len(data) > 12 and data[4:8] == b"ftyp":
        if data[8:12] == b"qt  ":
            raise ApiError("QuickTime .mov files do not play in every browser. Export the video as MP4 (H.264).", "invalid_video")
        return "video/mp4", "mp4"
    if data[:4] == bytes.fromhex("1a45dfa3") and b"webm" in data[:64]:
        return "video/webm", "webm"
    raise ApiError("Upload an MP4 or WebM video", "invalid_video")


async def save_video(data: bytes, max_bytes: int) -> str:
    """Stores a product video as uploaded (no re-encoding) after checking its type and size."""
    if len(data) > max_bytes:
        raise ApiError(f"Video must be smaller than {max_bytes // (1024 * 1024)} MB", "file_too_large")
    content_type, ext = sniff_video(data)
    key = f"videos/{uuid.uuid4().hex}.{ext}"
    if settings.storage_backend == "s3":
        await asyncio.to_thread(
            _s3().put_object, Bucket=settings.s3_bucket, Key=key, Body=data, ContentType=content_type,
            CacheControl="public, max-age=31536000, immutable",
        )
    else:
        path = Path(settings.media_root) / key
        path.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(path.write_bytes, data)
    return f"{settings.media_base_url.rstrip('/')}/{key}"


def sniff_document(data: bytes) -> tuple[str, str]:
    for magic, info in DOC_TYPES.items():
        if data.startswith(magic):
            return info
    raise ApiError("Upload a PDF, JPG or PNG file", "invalid_document")


async def save_private(data: bytes, folder: str) -> tuple[str, str]:
    if len(data) > settings.max_document_bytes:
        raise ApiError(f"File must be smaller than {settings.max_document_bytes // (1024 * 1024)} MB", "file_too_large")
    content_type, ext = sniff_document(data)
    key = f"{folder}/{uuid.uuid4().hex}.{ext}"
    if settings.storage_backend == "s3":
        await asyncio.to_thread(
            _s3().put_object,
            Bucket=settings.s3_private_bucket,
            Key=key,
            Body=data,
            ContentType=content_type,
            ServerSideEncryption="AES256",
        )
    else:
        path = Path(settings.private_root) / key
        path.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(path.write_bytes, data)
    return key, content_type


async def read_private(key: str) -> bytes:
    if ".." in key or key.startswith("/"):
        raise ApiError("Invalid key", "invalid_key")
    if settings.storage_backend == "s3":
        obj = await asyncio.to_thread(_s3().get_object, Bucket=settings.s3_private_bucket, Key=key)
        return obj["Body"].read()
    return await asyncio.to_thread((Path(settings.private_root) / key).read_bytes)
