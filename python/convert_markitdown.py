from __future__ import annotations

import argparse
import json
import os
import zipfile
from pathlib import Path
from typing import Any


TEXT_EXTENSIONS = {
    ".csv",
    ".html",
    ".htm",
    ".json",
    ".jsonl",
    ".log",
    ".markdown",
    ".md",
    ".rst",
    ".toml",
    ".tsv",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
}

IMAGE_EXTENSIONS = {
    ".avif",
    ".bmp",
    ".gif",
    ".heic",
    ".jpeg",
    ".jpg",
    ".png",
    ".tif",
    ".tiff",
    ".webp",
}

ARCHIVE_EXTENSIONS = {".7z", ".gz", ".rar", ".tar", ".zip"}
ARCHIVE_TEXT_MAX_FILES_DEFAULT = 40
ARCHIVE_TEXT_MAX_BYTES_DEFAULT = 200_000
AUDIO_VIDEO_EXTENSIONS = {
    ".aac",
    ".aiff",
    ".avi",
    ".flac",
    ".m4a",
    ".m4v",
    ".mkv",
    ".mov",
    ".mp3",
    ".mp4",
    ".mpeg",
    ".mpg",
    ".ogg",
    ".opus",
    ".wav",
    ".webm",
    ".wma",
    ".wmv",
}

FALSE_VALUES = {"0", "false", "FALSE", "no", "NO", "off", "OFF"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert one source file to a SearchX markdown sidecar.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--id", required=True)
    parser.add_argument("--root-id", required=True)
    parser.add_argument("--relative-path", required=True)
    parser.add_argument("--kind", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--size", required=True, type=int)
    parser.add_argument("--mtime-ms", required=True, type=float)
    parser.add_argument("--mode", choices=("single", "batch"), default="single")
    return parser.parse_args()


def yaml_value(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def read_text_fallback(source: Path) -> str:
    if source.suffix.lower() not in TEXT_EXTENSIONS:
        return ""
    return source.read_text(encoding="utf-8", errors="replace")


def enabled(name: str) -> bool:
    return os.environ.get(name) in {"1", "true", "TRUE", "yes", "YES"}


def disabled(name: str) -> bool:
    return os.environ.get(name, "").strip() in FALSE_VALUES


def int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


def under_limit(source: Path, env_name: str, default: int) -> bool:
    limit = int_env(env_name, default)
    return limit <= 0 or source.stat().st_size <= limit


def archive_section(source: Path) -> tuple[str, str | None]:
    if source.suffix.lower() != ".zip":
        return "", "Archive listing is only supported for ZIP files."
    max_entries = int_env("SEARCHX_ARCHIVE_LIST_MAX_ENTRIES", 200)
    max_text_files = int_env("SEARCHX_ARCHIVE_TEXT_MAX_FILES", ARCHIVE_TEXT_MAX_FILES_DEFAULT)
    max_text_bytes = int_env("SEARCHX_ARCHIVE_TEXT_MAX_BYTES", ARCHIVE_TEXT_MAX_BYTES_DEFAULT)
    try:
        with zipfile.ZipFile(source) as archive:
            infos = [info for info in archive.infolist() if not info.is_dir()]
            names = [info.filename for info in infos]
            text_sections = archive_text_sections(archive, infos, max_text_files, max_text_bytes)
    except Exception as exc:
        return "", f"Archive listing failed: {exc}"

    shown = names[:max_entries]
    more = len(names) - len(shown)
    lines = ["## Archive contents", "", *[f"- {name}" for name in shown]]
    if more > 0:
        lines.append(f"- ... {more} more entries omitted")
    if text_sections:
        lines.extend(["", "## Archive text excerpts", "", *text_sections])
    return "\n".join(lines), None


def archive_text_sections(
    archive: zipfile.ZipFile,
    infos: list[zipfile.ZipInfo],
    max_files: int,
    max_bytes: int,
) -> list[str]:
    if max_files <= 0 or max_bytes <= 0:
        return []

    sections: list[str] = []
    files_read = 0
    bytes_read = 0
    for info in infos:
        if files_read >= max_files or bytes_read >= max_bytes:
            break
        suffix = Path(info.filename).suffix.lower()
        if suffix not in TEXT_EXTENSIONS:
            continue
        if info.file_size <= 0:
            continue
        remaining = max_bytes - bytes_read
        read_size = min(info.file_size, remaining)
        try:
            with archive.open(info) as member:
                raw = member.read(read_size + 1)
        except Exception as exc:
            sections.append(f"### {info.filename}\n\nCould not read archive member: {exc}")
            files_read += 1
            continue
        truncated = len(raw) > read_size or info.file_size > read_size
        text = raw[:read_size].decode("utf-8", errors="replace").strip()
        if not text:
            continue
        if truncated:
            text = f"{text}\n\n... truncated ..."
        sections.append(f"### {info.filename}\n\n```text\n{text}\n```")
        files_read += 1
        bytes_read += read_size
    return sections


def should_run_markitdown(source: Path) -> bool:
    suffix = source.suffix.lower()
    if suffix in AUDIO_VIDEO_EXTENSIONS and disabled("SEARCHX_MARKITDOWN_MEDIA"):
        return False
    if suffix in ARCHIVE_EXTENSIONS:
        return False
    return under_limit(source, "SEARCHX_MARKITDOWN_MAX_BYTES", 80 * 1024 * 1024)


def build_markitdown(allow_llm: bool = False) -> Any:
    from markitdown import MarkItDown

    enable_plugins = not disabled("SEARCHX_MARKITDOWN_PLUGINS")
    enable_llm = allow_llm
    llm_model = os.environ.get("SEARCHX_LLM_MODEL")
    llm_prompt = os.environ.get("SEARCHX_LLM_PROMPT")

    if enable_llm and llm_model:
        from openai import OpenAI

        client_kwargs: dict[str, str] = {}
        base_url = os.environ.get("OPENAI_BASE_URL")
        api_key = os.environ.get("OPENAI_API_KEY")
        if base_url:
            client_kwargs["base_url"] = base_url
            client_kwargs["api_key"] = api_key or "local"
        elif api_key:
            client_kwargs["api_key"] = api_key

        client = OpenAI(**client_kwargs)
        kwargs = {
            "enable_plugins": enable_plugins,
            "llm_client": client,
            "llm_model": llm_model,
        }
        if llm_prompt:
            kwargs["llm_prompt"] = llm_prompt
        return MarkItDown(**kwargs)

    return MarkItDown(enable_plugins=enable_plugins)


def should_use_llm_provider() -> bool:
    if disabled("SEARCHX_MARKITDOWN_USE_LLM"):
        return False
    if enabled("SEARCHX_MARKITDOWN_USE_LLM"):
        return True
    return bool(os.environ.get("OPENAI_BASE_URL") and os.environ.get("SEARCHX_LLM_MODEL"))


def convert(source: Path, mode: str = "single") -> tuple[str, str, str | None]:
    sections: list[str] = []
    errors: list[str] = []
    markitdown_attempted = False

    if source.suffix.lower() in ARCHIVE_EXTENSIONS and not disabled("SEARCHX_MARKITDOWN_ARCHIVES"):
        archive_text, archive_error = archive_section(source)
        if archive_text:
            sections.append(archive_text)
        if archive_error:
            errors.append(archive_error)

    if should_run_markitdown(source):
        markitdown_attempted = True
        try:
            md = build_markitdown(allow_llm=should_use_llm_provider())
            result = md.convert(str(source))
            markitdown_text = (getattr(result, "text_content", "") or "").strip()
            if markitdown_text:
                sections.append("\n".join(["## MarkItDown extracted content", "", markitdown_text]))

        except Exception as exc:
            errors.append(f"MarkItDown failed: {exc}")

    if source.suffix.lower() in ARCHIVE_EXTENSIONS and (not markitdown_attempted or errors) and not sections:
        archive_text, archive_error = archive_section(source)
        if archive_text:
            sections.append(archive_text)
        if archive_error:
            errors.append(archive_error)

    if not sections:
        fallback = read_text_fallback(source)
        if fallback.strip():
            sections.append("\n".join(["## Raw text fallback", "", fallback.strip()]))

    if sections:
        return "\n\n".join(sections), "ok", "; ".join(errors) or None

    if errors:
        return "", "metadata_only", "; ".join(errors)
    return "", "metadata_only", "No text content was extracted."


def write_sidecar(args: argparse.Namespace, text: str, status: str, error: str | None) -> None:
    source = Path(args.input).resolve()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)

    frontmatter = [
        "---",
        f"searchx_id: {yaml_value(args.id)}",
        f"root_id: {yaml_value(args.root_id)}",
        f"title: {yaml_value(args.title)}",
        f"kind: {yaml_value(args.kind)}",
        f"source_path: {yaml_value(str(source))}",
        f"relative_path: {yaml_value(args.relative_path)}",
        f"size: {args.size}",
        f"mtime_ms: {args.mtime_ms}",
        f"conversion_status: {yaml_value(status)}",
        f"conversion_error: {yaml_value(error)}",
        "---",
        "",
    ]

    body = [
        f"# {args.title}",
        "",
        "## Source",
        "",
        f"- Path: `{source}`",
        f"- Relative path: `{args.relative_path}`",
        f"- Kind: `{args.kind}`",
        f"- Size: `{args.size}` bytes",
        "",
        "## Extracted content",
        "",
    ]

    if text.strip():
        body.append(text.strip())
    else:
        body.append("No extractable text is available yet. The file is indexed by metadata only.")

    temp_output = output.with_name(f"{output.name}.{os.getpid()}.tmp")
    temp_output.write_text("\n".join(frontmatter + body) + "\n", encoding="utf-8")
    temp_output.replace(output)


def main() -> int:
    args = parse_args()
    text, status, error = convert(Path(args.input), args.mode)
    write_sidecar(args, text, status, error)
    print(json.dumps({"status": status, "error": error}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
