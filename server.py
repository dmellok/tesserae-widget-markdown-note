"""markdown_note, markdown typed into a cell or read from one shared document.

The whole point of the URL mode is a shelf of e-ink label tags: 20 cells all
pointing at one markdown file, each pulling a different section out of it, so
relabelling a bin is an edit in one document instead of 20 dashboard visits.

Sectioning is deliberately forgiving because the document is written by hand:
``---`` rules split it when present, headings split it when they don't, and a
section is addressed by its heading text (case- and punctuation-insensitive) or
by its number. A miss returns the list of names that ARE in the document, which
is the only error message that actually helps someone wiring up 20 tags.

No markdown is rendered here. The client owns rendering so that inline text
keeps working when the server has nothing to add, and so the same renderer
draws both modes.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path
from typing import Any

from app import plugin_http

DEFAULT_TTL_S = 900
MIN_TTL_S = 60
HTTP_TIMEOUT_S = 12
MAX_DOC_CHARS = 200_000

RULE_RE = re.compile(r"^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$")
HEADING_RE = re.compile(r"^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$")
FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})")


def _slug(value: str) -> str:
    """Loose key for matching a section name a human retyped from memory."""
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def _strip_inline(text: str) -> str:
    """Heading text without its markdown punctuation, for display + matching."""
    out = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)
    out = re.sub(r"[*_`~]+", "", out)
    return out.strip()


def _first_heading(chunk: str) -> str:
    for line in chunk.splitlines():
        m = HEADING_RE.match(line)
        if m:
            return _strip_inline(m.group(2))
        if line.strip():
            return ""
    return ""


def _section_name(chunk: str, index: int) -> str:
    head = _first_heading(chunk)
    if head:
        return head
    for line in chunk.splitlines():
        if line.strip():
            return _strip_inline(line.strip())[:60]
    return str(index)


def _split_sections(doc: str) -> list[str]:
    """Split a document into label-sized chunks.

    Rules run in order: horizontal rules win when the author used them,
    otherwise the shallowest heading level that appears more than once. Code
    fences are respected so a ``---`` inside a block doesn't cut the label.
    """
    lines = doc.splitlines()
    fence: str | None = None
    rules: list[int] = []
    heads: dict[int, list[int]] = {}
    for i, line in enumerate(lines):
        fm = FENCE_RE.match(line)
        if fm:
            marker = fm.group(1)[0]
            if fence is None:
                fence = marker
            elif fence == marker:
                fence = None
            continue
        if fence is not None:
            continue
        if RULE_RE.match(line):
            rules.append(i)
            continue
        hm = HEADING_RE.match(line)
        if hm:
            heads.setdefault(len(hm.group(1)), []).append(i)

    if rules:
        chunks = []
        start = 0
        for i in rules:
            chunks.append("\n".join(lines[start:i]))
            start = i + 1
        chunks.append("\n".join(lines[start:]))
        return [c.strip("\n") for c in chunks if c.strip()]

    for level in sorted(heads):
        starts = heads[level]
        if len(starts) < 2:
            continue
        chunks = []
        if starts[0] > 0 and "\n".join(lines[: starts[0]]).strip():
            chunks.append("\n".join(lines[: starts[0]]))
        for n, start in enumerate(starts):
            end = starts[n + 1] if n + 1 < len(starts) else len(lines)
            chunks.append("\n".join(lines[start:end]))
        return [c.strip("\n") for c in chunks if c.strip()]

    body = doc.strip("\n")
    return [body] if body.strip() else []


def _pick(chunks: list[str], names: list[str], wanted: str) -> tuple[str, str, str]:
    """Return (chunk, name, error) for the requested section."""
    if not chunks:
        return "", "", "Document is empty."
    if not wanted:
        if len(chunks) == 1:
            return chunks[0], names[0], ""
        return "\n\n".join(chunks), "", ""

    key = _slug(wanted)
    if key.isdigit():
        idx = int(key)
        if 1 <= idx <= len(chunks):
            return chunks[idx - 1], names[idx - 1], ""

    slugs = [_slug(n) for n in names]
    if key in slugs:
        i = slugs.index(key)
        return chunks[i], names[i], ""
    starts = [i for i, s in enumerate(slugs) if s.startswith(key) and key]
    if len(starts) == 1:
        i = starts[0]
        return chunks[i], names[i], ""

    listing = ", ".join(names[:12]) + ("…" if len(names) > 12 else "")
    return "", "", f'No section "{wanted}". Document has: {listing}'


def _cache_path(ctx: dict[str, Any], url: str) -> Path | None:
    data_dir = ctx.get("data_dir") if ctx else None
    if not data_dir:
        return None
    key = hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]
    return Path(data_dir) / f"doc_{key}.json"


def _read_document(url: str, ttl_s: int, ctx: dict[str, Any]) -> tuple[str, float, str]:
    """Return (text, fetched_at, error), serving a cached copy inside the TTL.

    A failed refresh falls back to the last good copy: a shelf label going
    blank because the gist host blipped is worse than one showing yesterday's
    (identical) text.
    """
    path = _cache_path(ctx, url)
    cached: dict[str, Any] | None = None
    if path and path.exists():
        try:
            cached = json.loads(path.read_text("utf-8"))
        except (OSError, ValueError):
            cached = None
        if cached and time.time() - float(cached.get("at", 0)) < ttl_s:
            return str(cached.get("text", "")), float(cached.get("at", 0)), ""

    try:
        text = plugin_http.fetch_text(url, timeout=HTTP_TIMEOUT_S)
    except Exception as err:
        if cached:
            return str(cached.get("text", "")), float(cached.get("at", 0)), ""
        return "", 0.0, f"Couldn't read the document: {type(err).__name__}"

    text = text[:MAX_DOC_CHARS]
    now = time.time()
    if path:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"text": text, "at": now}), "utf-8")
        except OSError:
            pass
    return text, now, ""


def _strip_heading(chunk: str) -> str:
    lines = chunk.splitlines()
    for i, line in enumerate(lines):
        if not line.strip():
            continue
        if HEADING_RE.match(line):
            return "\n".join(lines[i + 1 :]).strip("\n")
        break
    return chunk


def fetch(
    options: dict[str, Any], settings: dict[str, Any], *, ctx: dict[str, Any]
) -> dict[str, Any]:
    url = str(options.get("source_url") or "").strip()
    wanted = str(options.get("section") or "").strip()

    try:
        ttl_s = max(MIN_TTL_S, int(float(options.get("refresh_min") or 15)) * 60)
    except (TypeError, ValueError):
        ttl_s = DEFAULT_TTL_S

    updated = time.time()
    if url:
        if not url.lower().startswith(("http://", "https://")):
            return {"error": "Document URL must start with http:// or https://"}
        doc, updated, err = _read_document(url, ttl_s, ctx or {})
        if err:
            return {"error": err, "source": "url", "url": url}
        source = "url"
    else:
        doc = str(options.get("text") or "")
        source = "inline"

    doc = doc.replace("\r\n", "\n").replace("\r", "\n")
    chunks = _split_sections(doc)
    names = [_section_name(c, i + 1) for i, c in enumerate(chunks)]
    chunk, name, err = _pick(chunks, names, wanted)
    if err:
        return {"error": err, "sections": names, "count": len(chunks), "source": source}

    return {
        "markdown": chunk,
        "title": _first_heading(chunk),
        "body": _strip_heading(chunk),
        "section": name,
        "sections": names,
        "count": len(chunks),
        "source": source,
        "url": url,
        "updated": int(updated),
    }
