"""Shared helpers for the self-host migration tools (stdlib only).

Nothing in here touches the network or a database. It is imported by the
CLI scripts in this directory and by the tests.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Iterable, Iterator

# ---------------------------------------------------------------------------
# Secret patterns
# ---------------------------------------------------------------------------

JWT_RE = re.compile(r"eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")

#: name -> compiled regex. Order matters only for reporting.
SECRET_PATTERNS: dict[str, re.Pattern[str]] = {
    "jwt": JWT_RE,
    "postgres_url": re.compile(r"postgres(?:ql)?://[^\s:/@]+:[^\s@]+@"),
    "tailscale_key": re.compile(r"tskey-[A-Za-z0-9_-]+"),
    "resend_key": re.compile(r"\bre_[A-Za-z0-9_]{20,}"),
    "sb_secret": re.compile(r"\bsb_secret_[A-Za-z0-9_-]+"),
    "sk_key": re.compile(r"\bsk_(?:live|test)?_?[A-Za-z0-9_-]{16,}"),
}

#: The subset that scrub_dump treats as a hard stop (spec: JWT, tskey-, sk_live, re_ keys).
SCRUB_HARD_FAIL_PATTERNS: dict[str, re.Pattern[str]] = {
    "jwt": JWT_RE,
    "tailscale_key": re.compile(r"tskey-"),
    "sk_live": re.compile(r"sk_live"),
    "resend_key": re.compile(r"\bre_[A-Za-z0-9]{20,}"),
}


def mask(token: str) -> str:
    """Return a non-reversible display form of a secret-looking token."""
    if len(token) <= 8:
        return "*" * len(token)
    return f"{token[:4]}…{token[-3:]} (len {len(token)})"


def find_secrets(line: str, patterns: dict[str, re.Pattern[str]] | None = None) -> list[tuple[str, str]]:
    """Return [(pattern_name, masked_match), ...] for every hit in `line`."""
    pats = patterns or SECRET_PATTERNS
    hits: list[tuple[str, str]] = []
    for name, rx in pats.items():
        for m in rx.finditer(line):
            hits.append((name, mask(m.group(0))))
    return hits


# ---------------------------------------------------------------------------
# Tabular input: CLI JSON {"rows":[...]} | JSON list | psql -A -F '|' output
# ---------------------------------------------------------------------------

_PSQL_FOOTER_RE = re.compile(r"^\(\d+ rows?\)$")


def load_rows(path: str, default_header: list[str] | None = None, sep: str = "|") -> list[dict[str, str]]:
    """Load rows from a file produced by either

    * ``supabase db query --linked -f x.sql > out.json``  -> ``{"rows": [...]}``
    * a plain JSON list of objects
    * ``psql -A -F '|' [-t]`` unaligned output (header optional; the
      ``(N rows)`` footer is ignored). When the first line does not look like
      a header, ``default_header`` is used.
    """
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    return parse_rows(text, default_header=default_header, sep=sep)


def parse_rows(text: str, default_header: list[str] | None = None, sep: str = "|") -> list[dict[str, str]]:
    stripped = text.lstrip()
    if stripped.startswith("{") or stripped.startswith("["):
        data = json.loads(stripped)
        if isinstance(data, dict):
            rows = data.get("rows")
            if rows is None:
                # some CLI versions wrap once more: {"result": {"rows": ...}}
                for v in data.values():
                    if isinstance(v, dict) and "rows" in v:
                        rows = v["rows"]
                        break
            if rows is None:
                raise ValueError("JSON object has no 'rows' key")
        else:
            rows = data
        out: list[dict[str, str]] = []
        for r in rows:
            if isinstance(r, dict):
                out.append({k: _to_text(v) for k, v in r.items()})
            elif isinstance(r, list) and default_header:
                out.append({k: _to_text(v) for k, v in zip(default_header, r)})
            else:
                raise ValueError(f"unsupported row shape: {r!r}")
        return out

    lines = [ln.rstrip("\r\n") for ln in text.splitlines()]
    lines = [ln for ln in lines if ln.strip() and not _PSQL_FOOTER_RE.match(ln.strip())]
    if not lines:
        return []
    header: list[str] | None = None
    first = lines[0].split(sep)
    if default_header is None:
        header = first
        lines = lines[1:]
    else:
        # treat the first line as a header only if it names exactly the expected columns
        if [c.strip().lower() for c in first] == [h.lower() for h in default_header]:
            header = list(default_header)
            lines = lines[1:]
        else:
            header = list(default_header)
    out = []
    for ln in lines:
        parts = ln.split(sep)
        if len(parts) < len(header):
            parts += [""] * (len(header) - len(parts))
        elif len(parts) > len(header):
            # value contained the separator: re-join the tail into the last column
            parts = parts[: len(header) - 1] + [sep.join(parts[len(header) - 1 :])]
        out.append(dict(zip(header, parts)))
    return out


def _to_text(v) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, (list, dict)):
        return json.dumps(v, sort_keys=True, separators=(",", ":"))
    return str(v)


# ---------------------------------------------------------------------------
# pg_dump COPY-block parser
# ---------------------------------------------------------------------------

COPY_HEADER_RE = re.compile(
    r'^COPY\s+(?P<schema>"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\.(?P<table>"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)'
    r"\s*\((?P<cols>.*)\)\s+FROM\s+stdin;\s*$"
)
COPY_TERMINATOR = "\\."


def _unquote(ident: str) -> str:
    if ident.startswith('"') and ident.endswith('"'):
        return ident[1:-1].replace('""', '"')
    return ident


def split_column_list(cols: str) -> list[str]:
    """Split the column list of a COPY header, honouring double quotes."""
    out: list[str] = []
    cur: list[str] = []
    in_q = False
    i = 0
    while i < len(cols):
        ch = cols[i]
        if ch == '"':
            if in_q and i + 1 < len(cols) and cols[i + 1] == '"':
                cur.append('"')
                i += 2
                continue
            in_q = not in_q
            cur.append(ch)
        elif ch == "," and not in_q:
            out.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
        i += 1
    if cur or out:
        out.append("".join(cur).strip())
    return [_unquote(c) for c in out if c != ""]


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


@dataclass
class CopyBlock:
    schema: str
    table: str
    columns: list[str]
    header_line: str
    data_lines: list[str] = field(default_factory=list)
    start_lineno: int = 0  # 1-based line number of the COPY header in the input
    terminated: bool = True

    @property
    def qualified(self) -> str:
        return f"{self.schema}.{self.table}"

    def render_header(self) -> str:
        cols = ", ".join(quote_ident(c) for c in self.columns)
        return f"COPY {quote_ident(self.schema)}.{quote_ident(self.table)} ({cols}) FROM stdin;"

    def render(self) -> Iterator[str]:
        yield self.render_header()
        yield from self.data_lines
        yield COPY_TERMINATOR


@dataclass
class TextLine:
    text: str
    lineno: int


Segment = CopyBlock | TextLine


def parse_dump(lines: Iterable[str]) -> Iterator[Segment]:
    """Yield TextLine / CopyBlock segments from dump lines (no trailing newlines).

    A COPY block ends ONLY on a line that is exactly ``\\.``. Data lines that
    start with ``--`` or contain backslashes are data, never SQL.
    """
    block: CopyBlock | None = None
    for i, raw in enumerate(lines, start=1):
        line = raw.rstrip("\r\n")
        if block is not None:
            if line == COPY_TERMINATOR:
                yield block
                block = None
            else:
                block.data_lines.append(line)
            continue
        m = COPY_HEADER_RE.match(line)
        if m:
            block = CopyBlock(
                schema=_unquote(m.group("schema")),
                table=_unquote(m.group("table")),
                columns=split_column_list(m.group("cols")),
                header_line=line,
                start_lineno=i,
            )
            continue
        yield TextLine(line, i)
    if block is not None:
        block.terminated = False
        yield block


def read_lines(path: str) -> list[str]:
    with open(path, encoding="utf-8", errors="surrogateescape", newline="") as fh:
        return [ln.rstrip("\n").rstrip("\r") for ln in fh]


def write_lines(path: str, lines: Iterable[str]) -> int:
    """Write lines with '\\n' endings; return bytes written."""
    n = 0
    with open(path, "w", encoding="utf-8", errors="surrogateescape", newline="\n") as fh:
        for ln in lines:
            s = ln + "\n"
            fh.write(s)
            n += len(s.encode("utf-8", errors="surrogateescape"))
    return n


def glob_match(name: str, pattern: str) -> bool:
    """fnmatch-style matching on schema.table names (case-sensitive)."""
    import fnmatch

    return fnmatch.fnmatchcase(name, pattern)
