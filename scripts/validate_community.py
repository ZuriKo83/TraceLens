from __future__ import annotations

import ast
import sys
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, TemplateSyntaxError

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
TEMPLATES = APP / "templates"


def validate_python() -> list[str]:
    errors: list[str] = []
    for path in sorted(APP.rglob("*.py")):
        try:
            ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except (SyntaxError, UnicodeDecodeError) as exc:
            errors.append(f"Python syntax error: {path.relative_to(ROOT)}: {exc}")
    return errors


def validate_templates() -> list[str]:
    errors: list[str] = []
    environment = Environment(loader=FileSystemLoader(str(TEMPLATES)), autoescape=True)
    for path in sorted(TEMPLATES.rglob("*.html")):
        template_name = path.relative_to(TEMPLATES).as_posix()
        try:
            environment.get_template(template_name)
        except TemplateSyntaxError as exc:
            errors.append(f"Jinja syntax error: {template_name}:{exc.lineno}: {exc.message}")
    return errors


def validate_required_files() -> list[str]:
    required = [
        APP / "community.py",
        APP / "community_models.py",
        APP / "templates" / "community" / "list.html",
        APP / "templates" / "community" / "form.html",
        APP / "templates" / "community" / "detail.html",
        APP / "templates" / "community" / "chat.html",
    ]
    return [f"Missing required file: {path.relative_to(ROOT)}" for path in required if not path.is_file()]


def main() -> int:
    errors = validate_required_files() + validate_python() + validate_templates()
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print("Community validation passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
