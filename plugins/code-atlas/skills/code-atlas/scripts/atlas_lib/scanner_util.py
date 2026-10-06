"""Small, position-preserving helpers for static source discovery."""
from dataclasses import dataclass
import re
from urllib.parse import urlsplit


@dataclass(frozen=True)
class Token:
    text: str
    start: int
    end: int


def tokens(text):
    # Strings stay opaque, including template literals. Comments never become code.
    pattern = r'''//[^\n]*|/\*[\s\S]*?\*/|(?:@?"(?:\\.|""|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|[A-Za-z_$][\w$]*|\d+|=>|\?\?|[^\s]'''
    return [Token(m.group(), m.start(), m.end()) for m in re.finditer(pattern, text)
            if not m.group().startswith(('//', '/*'))]


def pairs(ts):
    stack, result = [], {}
    for i, token in enumerate(ts):
        if token.text in ('(', '[', '{'):
            stack.append(i)
        elif token.text in (')', ']', '}'):
            if stack and ts[stack[-1]].text == {')': '(', ']': '[', '}': '{'}[token.text]:
                j = stack.pop()
                result[j] = i
    return result


def split_ranges(ts, start, end, matched, separator=','):
    begin, i = start, start
    while i < end:
        if ts[i].text == separator:
            yield begin, i
            begin = i + 1
        i = matched.get(i, i) + 1
    if begin < end:
        yield begin, end


def properties(ts, start, end, matched):
    result = {}
    for lo, hi in split_ranges(ts, start + 1, end, matched):
        if lo + 1 < hi and ts[lo + 1].text == ':':
            result[ts[lo].text.strip('\"\'')] = (lo + 2, hi)
    return result


def string_value(expression, constants=None, dynamic=False):
    """Resolve literal/constant concatenations, preserving simple URL parameters."""
    constants = constants or {}
    ts = tokens(expression.strip())
    if not ts:
        return None
    matched = pairs(ts)
    ranges = list(split_ranges(ts, 0, len(ts), matched, '+'))
    if len(ranges) > 1:
        values = [string_value(expression[ts[a].start:ts[b - 1].end], constants, dynamic)
                  for a, b in ranges if a < b]
        return ''.join(values) if len(values) == len(ranges) and all(v is not None for v in values) else None
    expression = expression.strip()
    if expression in constants:
        return constants[expression]
    if len(ts) == 1 and expression.startswith(('"', "'", '`')):
        value = expression[1:-1]
        if expression.startswith('`'):
            failed = False

            def replace(match):
                nonlocal failed
                name = match.group(1).strip()
                if name in constants:
                    return constants[name]
                if dynamic and re.fullmatch(r'[\w$]+(?:\.[\w$]+)*', name):
                    return '{' + name.split('.')[-1] + '}'
                failed = True
                return ''

            value = re.sub(r'\$\{([^}]+)\}', replace, value)
            if failed:
                return None
        return value.replace('\\/', '/')
    if dynamic and re.fullmatch(r'[\w$]+(?:\.[\w$]+)*', expression):
        return '{' + expression.split('.')[-1] + '}'
    return None


def normalize_path(path):
    if re.match(r'https?://', path):
        path = urlsplit(path).path
    # Preserve route parameters while dropping constraints / query strings.
    path = re.sub(r'\{([^}:]+):[^}]+\}', r'{\1}', path)
    path = re.sub(r'\(\?P<(\w+)>[^)]+\)', r'{\1}', path)
    path = re.sub(r'<(?:\w+:)?(\w+)>', r'{\1}', path)
    path = path.lstrip('^').rstrip('$')
    path = path.split('?', 1)[0].split('#', 1)[0]
    return '/' + '/'.join(piece for piece in path.split('/') if piece)


def join_path(*paths):
    return normalize_path('/'.join(path.lstrip('^').rstrip('$') for path in paths))


def pair_key(key):
    return re.sub(r'\{[^}]+\}|(?<=/)[:$][\w]+', '{}', key)


def item(kind, key, part, file, text, offset, source, symbol=None):
    result = dict(kind=kind, key=key, part=part['name'], file=file,
                  line=text.count('\n', 0, offset) + 1, source=source)
    if symbol:
        result['symbol'] = symbol
    return result
