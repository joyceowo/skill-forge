"""Resolve source symbols without accepting names inside comments or strings."""
from __future__ import annotations

import ast
import re
from pathlib import Path


def _mask(text: str) -> str:
    """Preserve offsets and newlines while hiding C#/JS comments and literals."""
    pattern = r'//[^\n]*|/\*[\s\S]*?\*/|@"(?:""|[^"])*"|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|`(?:\\.|[^`\\])*`'
    return re.sub(pattern, lambda m: re.sub(r'[^\n]', ' ', m.group()), text)


def _brace_end(text: str, opening: int) -> int:
    depth = 0
    for pos in range(opening, len(text)):
        if text[pos] == '{':
            depth += 1
        elif text[pos] == '}':
            depth -= 1
            if not depth:
                return pos
    return len(text)


def _class_regions(text: str) -> list[tuple[str, int, int, int | None]]:
    """Name, opening brace, closing brace, nearest enclosing type brace."""
    regions = []
    for match in re.finditer(r'\b(?:class|struct|record|interface|enum)\s+([A-Za-z_$][\w$]*)\b[^;{]*\{', text):
        opening = match.end() - 1
        enclosing = [region[1] for region in regions if region[1] < match.start() < region[2]]
        regions.append((match.group(1), opening, _brace_end(text, opening), max(enclosing, default=None)))
    return regions


def _python_line(text: str, symbol: str, stem: str) -> int | None:
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return None
    parts = symbol.split('.')
    if len(parts) > 1 and parts[0] == stem:
        parts = parts[1:]

    def find(body: list, remaining: list[str]) -> int | None:
        for node in body:
            if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == remaining[0]:
                if len(remaining) == 1:
                    return node.lineno
                result = find(node.body, remaining[1:])
                if result is not None:
                    return result
            if len(remaining) == 1 and isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                if any(isinstance(t, ast.Name) and t.id == remaining[0] for t in targets):
                    return node.lineno
        return None

    found = find(tree.body, parts)
    if found is not None:
        return found
    # Django URL declarations intentionally point at imported views.foo in urls.py.
    imports = set()
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            imports.update(alias.asname or alias.name.split('.')[0] for alias in node.names)
    if len(parts) > 1 and parts[0] in imports:
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and ast.unparse(node) == '.'.join(parts):
                return node.lineno
    return None


def find_symbol_line(path: Path, symbol: str | None) -> int | None:
    """Return a 1-based declaration/reference line, or None when unresolved.

    Python uses AST. C#/JS/TS use bounded declaration rules, not a full parser;
    qualified members must belong to the named class. No source is executed.
    """
    if not path.is_file():
        return None
    if symbol is None:
        return 1
    if not isinstance(symbol, str) or not re.fullmatch(r'[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*', symbol):
        return None
    try:
        text = path.read_text(encoding='utf-8-sig')
    except (OSError, UnicodeError):
        return None
    if path.suffix == '.py':
        return _python_line(text, symbol, path.stem)
    masked = _mask(text)
    if path.suffix == '.vue':
        # Template text is not a source declaration.
        spans = [m.span(1) for m in re.finditer(r'<script\b[^>]*>([\s\S]*?)</script\s*>', text)]
        masked = ''.join(c if c == '\n' or any(a <= i < b for a, b in spans) else ' ' for i, c in enumerate(masked))
    pieces = symbol.split('.')
    start, end = 0, len(masked)
    regions = _class_regions(masked)
    parent_brace = None
    for parent in pieces[:-1]:
        region = next((region for region in regions if region[0] == parent and region[3] == parent_brace), None)
        if region is None:
            # Minimal API route declarations can cite a method group whose class
            # is defined in another file. Match the complete qualified token.
            # Never use this fallback when the named class exists in this file.
            if len(pieces) == 2 and start == 0 and not any(region[0] == parent for region in regions):
                reference = re.search(r'(?<![\w$.])' + re.escape(symbol) + r'(?![\w$])', masked)
                if reference:
                    return masked.count('\n', 0, reference.start()) + 1
            return None
        _, parent_brace, end, _ = region
        start = parent_brace + 1
    name = re.escape(pieces[-1])
    scope = masked[start:end]
    if len(pieces) > 1:
        # Mask nested bodies so a same-named method in another class/local scope
        # cannot satisfy this class's evidence.
        chars = list(scope)
        depth = 0
        for pos, char in enumerate(scope):
            if char == '{':
                depth += 1
            elif char == '}':
                depth -= 1
            elif depth and char != '\n':
                chars[pos] = ' '
        scope = ''.join(chars)
        # Member declarations start at the class opening, or after a previous
        # member's closing brace/semicolon. Physical line breaks are irrelevant.
        boundary = r'(?:^|(?<=[;}]))\s*(?:\[[^\]]*\]\s*)*'
        member = r'(?P<symbol>' + name + ')'
        patterns = [
            boundary + r'(?:(?:public|private|protected|internal|static|async|virtual|override|sealed|abstract|readonly|const|new|partial|extern|unsafe)\s+)*(?:[\w.<>?,\[\]]+\s+)+' + member + r'\s*(?:\([^;{}]*\)\s*(?:=>|\{|;)|(?:=>|=|\{|;))',
            boundary + r'(?:(?:static|async|get|set)\s+)*' + member + r'\s*\([^;{}]*\)\s*(?::[^{}=]+)?\s*\{',
        ]
    else:
        patterns = [
            r'\b(?:class|struct|record|interface|enum|function)\s+' + name + r'\b',
            r'\b(?:const|let|var)\s+' + name + r'\b\s*(?::[^=;\n]+)?\s*=',
        ]
    matches = [match for pattern in patterns if (match := re.search(pattern, scope))]
    if not matches:
        return None
    match = min(matches, key=lambda item: item.start())
    offset = start + (match.start('symbol') if 'symbol' in match.groupdict() else match.start())
    return masked.count('\n', 0, offset) + 1
