"""Static React/Vue routes, page components, and literal HTTP calls."""
from pathlib import PurePosixPath
import posixpath
import re

from .scanner_util import item, join_path, normalize_path, pairs, properties, split_ranges, string_value, tokens


def _script(text, file):
    if not file.endswith('.vue'):
        return text
    # Blank non-script SFC content, retaining all offsets and line numbers.
    result = list(re.sub(r'[^\n]', ' ', text))
    for match in re.finditer(r'<script\b[^>]*>([\s\S]*?)</script\s*>', text, re.I):
        result[match.start(1):match.end(1)] = match.group(1)
    return ''.join(result)


class Source:
    def __init__(self, file, original):
        self.file, self.original = file, original
        self.text = _script(original, file)
        self.ts = tokens(self.text)
        self.matched = pairs(self.ts)
        self.constants = {}
        declarations = list(re.finditer(r'\bconst\s+(\w+)\s*=\s*([^\n;]+)', self.text))
        for _ in range(len(declarations) + 1):
            changed = False
            for match in declarations:
                value = string_value(match.group(2).strip(), self.constants)
                if value is not None and self.constants.get(match.group(1)) != value:
                    self.constants[match.group(1)] = value
                    changed = True
            if not changed:
                break
        self.functions = []
        ts = self.ts
        for i, token in enumerate(ts[:-2]):
            if token.text != 'function' or ts[i + 2].text != '(':
                continue
            end_args = self.matched.get(i + 2)
            if end_args is None:
                continue
            body = end_args + 1
            if body < len(ts) and ts[body].text == '{' and body in self.matched:
                self.functions.append((token.start, ts[self.matched[body]].end, ts[i + 1].text))
        for match in re.finditer(r'\b(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^\n]*?\)|\w+)\s*=>', self.text):
            if any(start <= match.start() < end for start, end, _ in self.functions):
                continue
            next_decl = re.search(r'\n(?:export\s+)?(?:const|function|async\s+function)\s', self.text[match.end():])
            end = match.end() + next_decl.start() if next_decl else len(self.text)
            self.functions.append((match.start(), end, match.group(1)))

    def expr(self, lo, hi):
        return self.text[self.ts[lo].start:self.ts[hi - 1].end] if lo < hi else ''

    def value(self, span, dynamic=False):
        return string_value(self.expr(*span), self.constants, dynamic) if span else None

    def symbol(self, offset):
        matches = [(end - start, name) for start, end, name in self.functions if start <= offset < end]
        return min(matches)[1] if matches else None


def _imports(source, files):
    aliases = {}
    for match in re.finditer(r'import\s+([^;\n]+?)\s+from\s+[\"\']([^\"\']+)[\"\']', source.text):
        bindings, module = match.groups()
        if module == 'axios':
            aliases[bindings.strip().split(',')[0]] = ('axios', 'default')
            continue
        if not module.startswith('.'):
            continue
        base = posixpath.normpath(posixpath.join(posixpath.dirname(source.file), module))
        target = next((name for name in (base, *(base + ext for ext in ('.ts', '.tsx', '.js', '.jsx')), base + '/index.ts', base + '/index.js') if name in files), None)
        if target:
            if '{' in bindings:
                for binding in bindings.split('{', 1)[1].split('}', 1)[0].split(','):
                    components = re.split(r'\s+as\s+', binding.strip())
                    if components[0]:
                        aliases[components[-1]] = (target, components[0])
            else:
                aliases[bindings.strip()] = (target, 'default')
    return aliases


def scan_frontend(sources, part):
    parsed = {file: Source(file, text) for file, text in sources.items()}
    imports = {file: _imports(source, parsed) for file, source in parsed.items()}
    clients, default_exports = {}, {}
    for file, source in parsed.items():
        local = {name: '' for name, (module, _) in imports[file].items() if module == 'axios'}
        ts = source.ts
        for i in range(len(ts) - 6):
            if ts[i].text != 'const' or ts[i + 2].text != '=' or ts[i + 3].text not in local:
                continue
            if [t.text for t in ts[i + 4:i + 7]] != ['.', 'create', '(']:
                continue
            if i + 7 < len(ts) and ts[i + 7].text == '{' and i + 7 in source.matched:
                fields = properties(ts, i + 7, source.matched[i + 7], source.matched)
                base = source.value(fields.get('baseURL'))
                # An empty initial base can be supplied later by a runtime interceptor.
                local[ts[i + 1].text] = base if base else part.get('apiPrefix', '')
        clients[file] = local
        for i in range(len(ts) - 2):
            if [token.text for token in ts[i:i + 2]] == ['export', 'default']:
                default_exports[file] = ts[i + 2].text
    for _ in range(len(parsed)):
        changed = False
        for file, bindings in imports.items():
            for name, (target, remote) in bindings.items():
                if target in clients and remote in clients[target] and name not in clients[file]:
                    clients[file][name] = clients[target][remote]
                    changed = True
        for file, name in default_exports.items():
            if name in clients[file] and 'default' not in clients[file]:
                clients[file]['default'] = clients[file][name]
                changed = True
        if not changed:
            break
    result = []
    for file, source in parsed.items():
        ts, matched = source.ts, source.matched

        def emit(kind, key, offset, rule, symbol=None):
            result.append(item(kind, key, part, file, source.original, offset, rule, symbol))

        path = PurePosixPath(file)
        is_page = any(file.startswith(directory.rstrip('/') + '/') for directory in part.get('pageDirs', []))
        if is_page and 'components' not in path.parts and path.suffix in ('.tsx', '.jsx', '.vue', '.js', '.ts'):
            component = next((span for span in source.functions if span[2][:1].isupper()), None)
            if file.endswith('.vue') or component:
                emit('page', file, component[0] if component else 0, 'page-directory', component[2] if component else None)

        # JSX routes: a stack preserves parent paths and pathless layout routes.
        jsx_stack = []
        code_openings = {token.start for token in ts if token.text == '<'}
        for match in re.finditer(r'<(/?)Route\b([^<>]*(?:<[^>]*>[^<>]*)?)>', source.text):
            if match.start() not in code_openings:
                continue  # The lexer keeps comments and string contents opaque.
            closing, attributes = match.groups()
            if closing:
                if jsx_stack:
                    jsx_stack.pop()
                continue
            route_match = re.search(r'\bpath\s*=\s*(?:\{\s*)?([\"\'][^\"\']*[\"\'])', attributes)
            route = string_value(route_match.group(1)) if route_match else None
            parent = jsx_stack[-1] if jsx_stack else ''
            full = normalize_path(route) if route and route.startswith('/') else join_path(parent, route or '')
            if route is not None:
                emit('route', full, match.start(), 'react-router')
            if not attributes.rstrip().endswith('/'):
                jsx_stack.append(full)

        # Routes represented by objects: recurse only through children arrays.
        def object_routes(array, parent=''):
            end = matched.get(array)
            if end is None:
                return
            for lo, hi in split_ranges(ts, array + 1, end, matched):
                if lo >= hi or ts[lo].text != '{' or lo not in matched:
                    continue
                fields = properties(ts, lo, matched[lo], matched)
                route = source.value(fields.get('path'))
                full = normalize_path(route) if route and route.startswith('/') else join_path(parent, route or '')
                if route is not None:
                    emit('route', full, ts[lo].start, 'vue-router' if part['framework'] == 'vue' else 'react-router')
                children = fields.get('children')
                if children and ts[children[0]].text == '[':
                    object_routes(children[0], full)

        if re.search(r"from\s*['\"](?:react-router(?:-dom)?|vue-router)['\"]", source.text):
            arrays = set()
            for i in range(len(ts) - 3):
                if ts[i].text in ('createBrowserRouter', 'createHashRouter', 'createMemoryRouter') and ts[i + 1].text == '(' and ts[i + 2].text == '[':
                    arrays.add(i + 2)
                if ts[i].text == 'routes' and ts[i + 1].text == '=' and ts[i + 2].text == '[':
                    arrays.add(i + 2)
            for array in sorted(arrays):
                object_routes(array)

        if '@tanstack/' in source.text:
            route_defs = {}
            for i in range(len(ts) - 5):
                if ts[i].text not in ('const', 'let') or ts[i + 2].text != '=' or ts[i + 3].text not in ('createRoute', 'createRootRoute'):
                    continue
                if ts[i + 5].text != '{' or i + 5 not in matched:
                    continue
                fields = properties(ts, i + 5, matched[i + 5], matched)
                parent = source.expr(*fields['getParentRoute']) if 'getParentRoute' in fields else ''
                parent_match = re.search(r'=>\s*(\w+)', parent)
                route_defs[ts[i + 1].text] = (source.value(fields.get('path')), parent_match.group(1) if parent_match else None, ts[i].start)

            def route_path(name, seen=frozenset()):
                if name not in route_defs or name in seen:
                    return ''
                route, parent, _ = route_defs[name]
                return join_path(route_path(parent, seen | {name}), route or '')

            for name, (route, _, offset) in route_defs.items():
                if route is not None:
                    emit('route', route_path(name), offset, 'tanstack-router')

        for i, token in enumerate(ts):
            receiver, method, call, rule = None, 'GET', None, None
            if token.text == 'fetch' and i + 1 < len(ts) and ts[i + 1].text == '(':
                call, rule = i + 1, 'fetch'
            elif token.text in clients[file] and i + 3 < len(ts) and ts[i + 1].text == '.' and ts[i + 2].text in ('get', 'post', 'put', 'patch', 'delete', 'head', 'options'):
                receiver, method, call, rule = token.text, ts[i + 2].text.upper(), i + 3, 'axios'
                if ts[call].text == '<':
                    depth = 1
                    call += 1
                    while call < len(ts) and depth:
                        depth += (ts[call].text == '<') - (ts[call].text == '>')
                        call += 1
            if call is None or call >= len(ts) or ts[call].text != '(' or call not in matched:
                continue
            args = list(split_ranges(ts, call + 1, matched[call], matched))
            if not args:
                continue
            route = source.value(args[0], dynamic=True)
            if route is None or not route.startswith(('/', 'http://', 'https://')):
                continue
            if rule == 'fetch' and len(args) > 1 and ts[args[1][0]].text == '{':
                fields = properties(ts, args[1][0], matched[args[1][0]], matched)
                if 'method' in fields:
                    method = (source.value(fields['method']) or 'ANY').upper()
            base = clients[file].get(receiver, '')
            route = normalize_path(route) if re.match(r'https?://', route) else join_path(base, route)
            emit('api-call', method + ' ' + route, token.start, rule, source.symbol(token.start))
    return result
