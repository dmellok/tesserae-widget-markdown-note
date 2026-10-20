"""markdown_note: sectioning, caching and the render mount."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest
from flask.testing import FlaskClient

from plugins.markdown_note import server

TWO_BINS = "# Pantry\nRice\n\n---\n\n# Garage\nPaint\n"
BY_HEADING = "# Pantry\nRice\n# Garage\nPaint\n# Craft\nYarn\n"


def call(**options: Any) -> dict[str, Any]:
    return server.fetch(options, {}, ctx={})


@pytest.mark.parametrize("size", ["xs", "sm", "md", "lg"])
def test_markdown_note_renders(client: FlaskClient, size: str) -> None:
    resp = client.get(f"/_test/render?plugin=markdown_note&size={size}")
    assert resp.status_code == 200


def test_inline_text_passes_through() -> None:
    out = call(text="# Pantry\nRice")
    assert out["markdown"] == "# Pantry\nRice"
    assert out["title"] == "Pantry"
    assert out["body"] == "Rice"
    assert out["source"] == "inline"
    assert out["count"] == 1


def test_rule_splits_sections() -> None:
    out = call(text=TWO_BINS, section="Garage")
    assert out["section"] == "Garage"
    assert out["markdown"].strip() == "# Garage\nPaint"
    assert out["sections"] == ["Pantry", "Garage"]


def test_headings_split_when_no_rules() -> None:
    out = call(text=BY_HEADING, section="craft")
    assert out["sections"] == ["Pantry", "Garage", "Craft"]
    assert out["markdown"].strip() == "# Craft\nYarn"


def test_section_matches_by_number_and_prefix() -> None:
    assert call(text=BY_HEADING, section="2")["section"] == "Garage"
    assert call(text=BY_HEADING, section="pan")["section"] == "Pantry"
    assert call(text=BY_HEADING, section="P A N T R Y!")["section"] == "Pantry"


def test_section_zero_picks_a_random_section() -> None:
    seen = set()
    for _ in range(60):
        out = call(text=BY_HEADING, section="0")
        assert out["markdown"].startswith(f"# {out['section']}")
        seen.add(out["section"])
    assert seen == {"Pantry", "Garage", "Craft"}


def test_blank_section_shows_whole_document() -> None:
    out = call(text=TWO_BINS)
    assert "Pantry" in out["markdown"]
    assert "Garage" in out["markdown"]
    assert out["section"] == ""


def test_missing_section_lists_what_is_there() -> None:
    out = call(text=TWO_BINS, section="Attic")
    assert "Attic" in out["error"]
    assert "Pantry" in out["error"]
    assert out["sections"] == ["Pantry", "Garage"]


def test_rule_inside_a_code_fence_does_not_split() -> None:
    out = call(text="# Bin\n\n```\n---\n```\n")
    assert out["count"] == 1


def test_url_must_be_http() -> None:
    assert "http" in call(source_url="file:///etc/passwd")["error"]


def test_url_is_fetched_and_cached(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    def fake_fetch_text(url: str, **kwargs: Any) -> str:
        calls.append(url)
        return TWO_BINS

    monkeypatch.setattr(server.plugin_http, "fetch_text", fake_fetch_text)
    options = {
        "source_url": "https://example.test/labels.md",
        "section": "Pantry",
        "refresh_min": 15,
    }
    ctx = {"data_dir": str(tmp_path)}

    first = server.fetch(options, {}, ctx=ctx)
    second = server.fetch(options, {}, ctx=ctx)

    assert first["section"] == "Pantry"
    assert first["source"] == "url"
    assert second["markdown"] == first["markdown"]
    assert len(calls) == 1


def test_stale_cache_survives_a_failed_refresh(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    url = "https://example.test/labels.md"
    path = server._cache_path({"data_dir": str(tmp_path)}, url)
    assert path is not None
    path.write_text(json.dumps({"text": TWO_BINS, "at": time.time() - 86400}), "utf-8")

    def boom(_url: str, **kwargs: Any) -> str:
        raise OSError("network down")

    monkeypatch.setattr(server.plugin_http, "fetch_text", boom)
    out = server.fetch(
        {"source_url": url, "section": "Garage"}, {}, ctx={"data_dir": str(tmp_path)}
    )
    assert out["section"] == "Garage"


def test_fetch_failure_without_cache_is_a_friendly_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(_url: str, **kwargs: Any) -> str:
        raise OSError("network down")

    monkeypatch.setattr(server.plugin_http, "fetch_text", boom)
    out = server.fetch(
        {"source_url": "https://example.test/labels.md"}, {}, ctx={"data_dir": str(tmp_path)}
    )
    assert "Couldn't read" in out["error"]
