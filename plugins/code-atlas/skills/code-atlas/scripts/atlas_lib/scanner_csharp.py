"""Common ASP.NET attribute, minimal API, and ABP conventional routes."""
import re

from .scanner_util import item, join_path, normalize_path, pairs, split_ranges, string_value, tokens


def _kebab(name):
    return re.sub(r'(?<=[a-z0-9])(?=[A-Z])', '-', name).lower()


def scan_csharp(sources, part):
    result = []
    conventional = any('ConventionalControllers' in text for text in sources.values())
    for file, text in sources.items():
        ts = tokens(text)
        matched = pairs(ts)
        backwards = {v: k for k, v in matched.items()}

        def expr(lo, hi):
            return text[ts[lo].start:ts[hi - 1].end] if lo < hi else ''

        def attrs(before):
            values = []
            while before >= 0 and ts[before].text == ']' and before in backwards:
                start = backwards[before]
                values.insert(0, expr(start + 1, before))
                before = start - 1
            return '\n'.join(values)

        groups = {}
        for i in range(len(ts) - 4):
            if ts[i + 1].text != '.' or ts[i + 3].text != '(' or i + 3 not in matched:
                continue
            receiver, method = ts[i].text, ts[i + 2].text
            if method not in ('MapGroup', 'MapGet', 'MapPost', 'MapPut', 'MapPatch', 'MapDelete', 'MapMethods'):
                continue
            arguments = list(split_ranges(ts, i + 4, matched[i + 3], matched))
            route = string_value(expr(*arguments[0])) if arguments else None
            if route is None:
                continue
            route = join_path(groups.get(receiver, ''), route)
            if method == 'MapGroup':
                if i >= 2 and ts[i - 1].text == '=':
                    groups[ts[i - 2].text] = route
                continue
            methods = [method[3:].upper()]
            handler_arg = 1
            if method == 'MapMethods':
                methods = re.findall(r'[\"\'](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)[\"\']', expr(*arguments[1])) if len(arguments) > 1 else []
                handler_arg = 2
            symbol = expr(*arguments[handler_arg]).strip() if len(arguments) > handler_arg else None
            if symbol and not re.fullmatch(r'\w+(?:\.\w+)*', symbol):
                symbol = None
            for verb in methods:
                result.append(item('endpoint', verb + ' ' + route, part, file, text, ts[i].start, 'aspnet-minimal', symbol))

        for c, token in enumerate(ts):
            if token.text != 'class' or c + 1 >= len(ts):
                continue
            name = ts[c + 1].text
            opening = next((j for j in range(c + 2, len(ts)) if ts[j].text == '{'), None)
            if opening not in matched:
                continue
            beginning = c - 1
            modifiers = []
            while beginning >= 0 and ts[beginning].text in ('public', 'internal', 'abstract', 'partial', 'sealed', 'static'):
                modifiers.append(ts[beginning].text)
                beginning -= 1
            class_attrs = attrs(beginning)
            if re.search(r'RemoteService\s*\([^)]*(?:IsEnabled\s*=\s*)?false', class_attrs):
                continue
            routes = re.findall(r'\bRoute\s*\(\s*"([^"]*)"', class_attrs)
            is_controller = name.endswith('Controller') or 'ControllerBase' in expr(c, opening)
            is_abp = conventional and name.endswith('AppService') and 'abstract' not in modifiers
            if not is_controller and not is_abp:
                continue
            routes = routes or ['']
            i = opening + 1
            while i < matched[opening]:
                if ts[i].text in ('{', '('):
                    i = matched.get(i, i) + 1
                    continue
                if ts[i].text != 'public':
                    i += 1
                    continue
                attributes = attrs(i - 1)
                j = i + 1
                while j < matched[opening] and ts[j].text not in ('(', ';', '=', '{', '=>'):
                    j += 1
                if j >= matched[opening] or ts[j].text != '(' or j not in matched:
                    i = j + 1
                    continue
                method_name = ts[j - 1].text
                if method_name == name or 'NonAction' in attributes or re.search(r'RemoteService\s*\([^)]*(?:IsEnabled\s*=\s*)?false', attributes):
                    i = matched[j] + 1
                    continue
                method_routes = re.findall(r'\bRoute\s*\(\s*"([^"]*)"', attributes)
                http = re.findall(r'\bHttp(Get|Post|Put|Patch|Delete|Head|Options)(?:\s*\(\s*"([^"]*)"[^)]*\))?', attributes)
                if is_controller:
                    for verb, template in http:
                        templates = [template] if template else method_routes or ['']
                        for prefix in routes:
                            for template in templates:
                                route = normalize_path(template[1:] if template.startswith('~/') else template) if template.startswith(('~/', '/')) else join_path(prefix, template)
                                route = route.replace('[controller]', name.removesuffix('Controller').lower()).replace('[action]', method_name)
                                result.append(item('endpoint', verb.upper() + ' ' + route, part, file, text, ts[j - 1].start, 'aspnet-attribute', name + '.' + method_name))
                elif is_abp:
                    stem = method_name.removesuffix('Async')
                    verbs = [('GetList', 'GET'), ('GetAll', 'GET'), ('Get', 'GET'), ('Put', 'PUT'), ('Update', 'PUT'),
                             ('Delete', 'DELETE'), ('Remove', 'DELETE'), ('Create', 'POST'), ('Add', 'POST'), ('Insert', 'POST'), ('Post', 'POST'), ('Patch', 'PATCH')]
                    prefix, verb = next(((p, v) for p, v in verbs if stem.startswith(p)), ('', 'POST'))
                    action = stem[len(prefix):]
                    route = '/api/app/' + _kebab(name.removesuffix('AppService'))
                    params = expr(j + 1, matched[j])
                    if re.search(r'\b\w+(?:<[^>]+>)?\??\s+id\b', params):
                        route += '/{id}'
                    if action:
                        route += '/' + _kebab(action)
                    result.append(item('endpoint', verb + ' ' + route, part, file, text, ts[j - 1].start, 'abp-conventional', name + '.' + method_name))
                i = matched[j] + 1
    return result
