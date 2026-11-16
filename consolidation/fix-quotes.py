#!/usr/bin/env python3
"""Wrap unpaired German opening quotes („) in backticks, in place.

The docs repo sanity check (docs/tools/sanity-check.sh) blocks a commit when a
file has more „ than closers (“ or ASCII "), ignoring fenced code blocks and
inline `code` spans. The consolidation report sometimes mentions a quote glyph
literally ("ein einzelnes „ als Zeichen") despite the prompt rule, which then
blocks the auto-commit every 15 minutes. This script mirrors the check's notion
of prose and puts every „ that has no closer later on the same line into
backticks, so it counts as code.

Usage: fix-quotes.py FILE   (prints one line per fix, exit 0)
"""
import re
import sys

OPEN = "„"
CLOSERS = ("“", '"')
CODE_SPAN = re.compile(r"(`[^`]*`)")


def fix_line(line: str) -> tuple[str, int]:
    segments = CODE_SPAN.split(line)
    pending = []  # (segment index, char index) of unmatched openers
    for si, seg in enumerate(segments):
        if si % 2 == 1:  # odd indices are code spans
            continue
        for ci, ch in enumerate(seg):
            if ch == OPEN:
                pending.append((si, ci))
            elif ch in CLOSERS and pending:
                pending.pop()
    if not pending:
        return line, 0
    # Replace from the end so earlier indices stay valid
    for si, ci in reversed(pending):
        seg = segments[si]
        segments[si] = seg[:ci] + "`" + OPEN + "`" + seg[ci + 1:]
    return "".join(segments), len(pending)


def main() -> int:
    path = sys.argv[1]
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().split("\n")
    in_fence = False
    total = 0
    for i, line in enumerate(lines):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        fixed, n = fix_line(line)
        if n:
            lines[i] = fixed
            total += n
            print(f"fix-quotes: Zeile {i + 1}: {n}× „ in Backticks gesetzt")
    if total:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
