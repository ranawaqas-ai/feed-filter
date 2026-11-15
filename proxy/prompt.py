"""The exact Jev request the evaluation measured (REPORT.md): jev-1.14.0, Noul,
wording N1, state {"goal", "video"}, one video per request.

format_video reproduces scripts/common.format_video so the live input matches the
evaluated input; tests/test_prompt.py checks the two stay identical.
"""

from typesafe_sdk import Noul

JEV_MODEL = "jev-1.14.0"
WORDING_ID = "N1"
WORDING = "Does the video in `video` serve the goal in `goal`?"


def _duration(seconds: int | None) -> str:
    if seconds is None:
        return "unknown"  # live streams and premieres; the evaluation never saw these
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _views(n: int | None) -> str:
    if n is None:
        return "unknown"
    for unit, size in (("B", 1e9), ("M", 1e6), ("K", 1e3)):
        if n >= size:
            return f"{n / size:.1f}{unit}"
    return str(n)


def format_video(video: dict) -> str:
    """video keys: title, channel, durationSeconds, viewCount, isShort, description."""
    kind = "Short" if video.get("isShort") else "video"
    lines = [
        f"Title: {video['title']}",
        f"Channel: {video['channel']}",
        f"Duration: {_duration(video.get('durationSeconds'))} ({kind})",
        f"Views: {_views(video.get('viewCount'))}",
    ]
    if video.get("description"):
        lines.append(f"Description: {video['description']}")
    return "\n".join(lines)


def build_request(goal: str, video: dict) -> tuple[dict, dict]:
    state = {"goal": goal, "video": format_video(video)}
    questions = {"v0": Noul(instructions=WORDING)}
    return state, questions
