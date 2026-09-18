# {{projectName}}

## Entwicklung

    python -m venv .venv
    .venv\Scripts\activate      # Windows
    source .venv/bin/activate   # macOS/Linux
    pip install -e ".[dev]"

    python -c "import {{pythonPackageName}}; {{pythonPackageName}}.main()"

## Tests & Linting

    pytest
    ruff check .
