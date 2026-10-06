"""AST-only Python web routing discovery; never imports application code."""
import ast
from pathlib import PurePosixPath

from .common import AtlasError
from .scanner_util import item, join_path


def _name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _name(node.value)
        return parent + '.' + node.attr if parent else node.attr
    return ''


def _literal(node, default=None):
    try:
        return ast.literal_eval(node)
    except (ValueError, TypeError, SyntaxError):
        return default


def _kw(call, key, default=None):
    return next((_literal(k.value, default) for k in call.keywords if k.arg == key), default)


def scan_python(sources, part):
    modules = {}
    for file, text in sources.items():
        relative = PurePosixPath(file).relative_to(PurePosixPath(part['path'])) if part['path'] != '.' else PurePosixPath(file)
        module = '.'.join(relative.with_suffix('').parts)
        if module.endswith('.__init__'):
            module = module[:-9]
        try:
            tree = ast.parse(text, filename=file)
        except SyntaxError as exc:
            raise AtlasError(f'Cannot parse Python source {file}:{exc.lineno}: {exc.msg}') from exc
        aliases = {}
        for node in tree.body:
            if isinstance(node, ast.ImportFrom):
                base = node.module or ''
                if node.level:
                    components = module.split('.')
                    if relative.name != '__init__.py':
                        components.pop()
                    base = '.'.join(components[:len(components) - node.level + 1] + ([base] if base else []))
                for alias in node.names:
                    aliases[alias.asname or alias.name] = '.'.join(filter(None, (base, alias.name)))
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    aliases[alias.asname or alias.name.split('.')[0]] = alias.name if alias.asname else alias.name.split('.')[0]
        modules[module] = (file, text, tree, aliases)

    def resolve(module, name):
        head, dot, tail = name.partition('.')
        return modules[module][3].get(head, module + '.' + head) + (dot + tail if dot else '')

    def entry(module, node, key, symbol, source):
        file, text, *_ = modules[module]
        offset = sum(len(line) for line in text.splitlines(keepends=True)[:node.lineno - 1]) + node.col_offset
        return item('endpoint', key, part, file, text, offset, source, symbol)

    if part['framework'] == 'django':
        return _django(modules, resolve, entry)
    objects, parents, decorated = {}, {}, []
    for module, (_, _, tree, _) in modules.items():
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
                constructor = _name(node.value.func).split('.')[-1]
                if constructor in ('FastAPI', 'APIRouter', 'Flask', 'Blueprint'):
                    prefix = _kw(node.value, 'prefix' if constructor == 'APIRouter' else 'url_prefix', '')
                    if not isinstance(prefix, str):
                        prefix = ''
                    for target in node.targets:
                        if isinstance(target, ast.Name):
                            objects[module + '.' + target.id] = (prefix, constructor in ('FastAPI', 'Flask'))
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.args:
                method = node.func.attr
                if method in ('include_router', 'register_blueprint'):
                    target = resolve(module, _name(node.args[0]))
                    parent = resolve(module, _name(node.func.value))
                    prefix = _kw(node, 'prefix' if method == 'include_router' else 'url_prefix', None)
                    parents.setdefault(target, []).append((parent, prefix, method == 'register_blueprint'))
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for decorator in node.decorator_list:
                    if isinstance(decorator, ast.Call) and isinstance(decorator.func, ast.Attribute) and decorator.args:
                        method = decorator.func.attr.lower()
                        if method in ('get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'route', 'api_route'):
                            route = _literal(decorator.args[0])
                            if isinstance(route, str):
                                methods = _kw(decorator, 'methods', ['GET']) if method in ('route', 'api_route') else [method.upper()]
                                decorated.append((module, node, resolve(module, _name(decorator.func.value)), route, methods))

    def prefixes(owner, seen=frozenset()):
        if owner in seen or owner not in objects:
            return []
        own, root = objects[owner]
        if root:
            return [own]
        result = []
        for parent, prefix, override in parents.get(owner, []):
            if prefix is not None and not isinstance(prefix, str):
                continue
            own_prefix = prefix if override and prefix is not None else join_path(prefix or '', own)
            result.extend(join_path(value, own_prefix) for value in prefixes(parent, seen | {owner}))
        return result

    result = []
    for module, node, owner, route, methods in decorated:
        for prefix in prefixes(owner):
            for method in methods:
                result.append(entry(module, node, method.upper() + ' ' + join_path(prefix, route), node.name, part['framework']))
    return result


def _django(modules, resolve, entry):
    registrations, includes, definitions = {}, {}, {}
    for module, (_, _, tree, _) in modules.items():
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                definitions[module + '.' + node.name] = node
            if not isinstance(node, ast.Assign) or not any(isinstance(target, ast.Name) and target.id == 'urlpatterns' for target in node.targets):
                continue
            for call in ast.walk(node.value):
                if not isinstance(call, ast.Call) or _name(call.func).split('.')[-1] not in ('path', 're_path') or len(call.args) < 2:
                    continue
                route, view = _literal(call.args[0]), call.args[1]
                if not isinstance(route, str):
                    continue
                if isinstance(view, ast.Call) and _name(view.func).split('.')[-1] == 'include' and view.args:
                    included = _literal(view.args[0])
                    if isinstance(included, str):
                        includes.setdefault(included, []).append((module, route))
                else:
                    symbol = _name(view.func.value) if isinstance(view, ast.Call) and isinstance(view.func, ast.Attribute) and view.func.attr == 'as_view' else _name(view)
                    if symbol and not symbol.startswith('admin.'):
                        registrations.setdefault(module, []).append((call, route, symbol))

    def prefixes(module, seen=frozenset()):
        if module in seen:
            return []
        if module not in includes:
            return ['']
        return [join_path(prefix, route) for parent, route in includes[module]
                for prefix in prefixes(parent, seen | {module})]

    def methods(node):
        if isinstance(node, ast.ClassDef):
            verbs = [n.name.upper() for n in node.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
                     and n.name in ('get', 'post', 'put', 'patch', 'delete', 'head', 'options')]
            return verbs or ['ANY']
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for decorator in node.decorator_list:
                if isinstance(decorator, ast.Call) and decorator.args and _name(decorator.func).endswith('require_http_methods'):
                    return _literal(decorator.args[0], ['ANY'])
                if _name(decorator).endswith('require_GET'):
                    return ['GET']
                if _name(decorator).endswith('require_POST'):
                    return ['POST']
                if _name(decorator).endswith('require_safe'):
                    return ['GET', 'HEAD']
        return ['ANY']

    result = []
    for module, rows in registrations.items():
        for call, route, symbol in rows:
            for prefix in prefixes(module):
                for method in methods(definitions.get(resolve(module, symbol))):
                    result.append(entry(module, call, method + ' ' + join_path(prefix, route), symbol, 'django'))
    return result
