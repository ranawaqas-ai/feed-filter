"""Pins format_video to a committed fixture that the extension's formatVideo also checks,
so the direct (in-browser) mode sends Jev the same text the proxy sends.
The videos are synthetic edge cases, not anyone's feed."""

import json
from pathlib import Path

from proxy.prompt import format_video

FIXTURE = Path(__file__).resolve().parents[2] / "extension" / "test" / "format_video_fixture.json"


def synthetic_videos() -> list[dict]:
    durations = [None, 0, 9, 59, 60, 61, 599, 3599, 3600, 3661, 36000, 45296]
    views = [None, 0, 7, 999, 1000, 1049, 1050, 1051, 12345, 999_499, 999_999, 1_000_000,
             1_049_999, 1_250_000, 999_999_999, 1_000_000_000, 2_345_678_901]
    titles = ["Plain title", "Ünïcödé — and \"quotes\"", "Emoji 🎬 title", "Line\nbreak", "  spaced  "]
    out = []
    for i in range(40):
        out.append({
            "videoId": f"synthetic{i:02d}",
            "title": titles[i % len(titles)],
            "channel": f"Channel {i % 7}",
            "durationSeconds": durations[i % len(durations)],
            "viewCount": views[i % len(views)],
            "isShort": i % 5 == 0,
            "description": "A description." if i % 4 == 0 else "",
        })
    return out


def test_format_video_fixture_is_current():
    expected = [{"video": v, "text": format_video(v)} for v in synthetic_videos()]
    assert json.loads(FIXTURE.read_text(encoding="utf-8")) == expected, "regenerate the fixture"
    print(f"PASS proxy.prompt.format_video: matches the {len(expected)}-case fixture the extension checks")
