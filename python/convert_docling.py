from __future__ import annotations

import argparse
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert one source file to Markdown with Docling.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = Path(args.input).resolve()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)

    try:
        from docling.document_converter import DocumentConverter

        result = DocumentConverter().convert(str(source))
        markdown = result.document.export_to_markdown().strip()
        output.write_text(markdown, encoding="utf-8")
        print(json.dumps({"status": "ok", "chars": len(markdown)}, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
