"""Read-only validation of Atlas documents, references and inventory coverage."""
from __future__ import annotations

import fnmatch
import re
from pathlib import Path

from .common import AtlasError, read_json, resolve_source
from .evidence import find_symbol_line
from .rule_model import rule_owners, review_candidates

_SEGMENT = r'[a-z0-9]+(?:-[a-z0-9]+)*'
_METHODS = r'(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY)'
_ENDPOINT = re.compile(_METHODS + r' /[^\s]*')
_SECRET = re.compile(
    r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'
    r'|\bAKIA[0-9A-Z]{16}\b'
    r'|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b'
    r'|\bBearer\s+[A-Za-z0-9_.-]{16,}'
    r'|\b(?:password|passwd|pwd|api[_-]?key|client[_-]?secret|access[_-]?token|connectionstring)\s*[=:]\s*["\']?[^\s"\'`;<>]{4,}'
    r'|(?:密碼|金鑰|連線字串)\s*[:=：]\s*[^\s"\'`;<>]{4,}'
    r'|\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis)://[^\s/:]+:[^\s/@]+@',
    re.IGNORECASE,
)


def _normalize_path(value: str) -> str:
    value = re.sub(r'\$\{[^}]+\}|\{[^}]+\}|<[^>]+>', '{}', value)
    value = re.sub(r'(?<=/)(?::|\$)[\w]+', '{}', value)
    return value.rstrip('/') or '/'


def _endpoint_key(value: str) -> str:
    method, _, path = value.partition(' ')
    return method + ' ' + _normalize_path(path)


def validate_atlas(project_root: Path, atlas_dir: Path) -> dict:
    """Validate without changing any file, including manual overrides."""
    root, atlas = Path(project_root).resolve(), Path(atlas_dir).resolve()
    errors: list[str] = []
    warnings: list[str] = []
    ids: dict[str, str] = {}
    dependencies: list[tuple[str, str, set[str] | None]] = []
    towns: list[dict] = []
    symbol_cache: dict[tuple[Path, str | None], int | None] = {}
    exclude: list[str] = []
    roots: dict[str, Path] = {}
    multi = False
    rule_ids = set()
    rule_dependencies = []
    legacy_rules = 0
    uncertain_rules = 0

    def error(label: str, message: str) -> None:
        errors.append(f'{label}: {message}')

    def secret_check(value, label: str) -> None:
        if isinstance(value, str) and _SECRET.search(value):
            error(label, 'possible secret in document; remove the sensitive value')
        elif isinstance(value, dict):
            for index, (key, child) in enumerate(value.items()):
                if re.fullmatch(r'(?i)(password|passwd|pwd|api[_-]?key|client[_-]?secret|access[_-]?token|connectionstring)', key) and isinstance(child, str) and child.strip():
                    error(f'{label}.value[{index}]', 'possible secret in document; remove the sensitive value')
                secret_check(key, f'{label}.key[{index}]')
                # Index paths avoid accidentally printing a sensitive object key.
                secret_check(child, f'{label}.value[{index}]')
        elif isinstance(value, list):
            for index, child in enumerate(value):
                secret_check(child, f'{label}[{index}]')

    def load(path: Path, required: bool = True):
        label = path.relative_to(atlas).as_posix()
        if not path.exists():
            if required:
                error(label, 'required file is missing')
            return None
        try:
            if not path.resolve().is_relative_to(atlas):
                error(label, 'document path escapes atlas directory')
                return None
            result = read_json(path)
        except (AtlasError, OSError, ValueError, UnicodeError):
            error(label, 'cannot read valid UTF-8 JSON')
            return None
        secret_check(result, label)
        if not isinstance(result, dict):
            error(label, 'must be an object')
            return None
        return result

    def strings(value, label: str, minimum: int = 0) -> list[str]:
        if not isinstance(value, list) or len(value) < minimum:
            error(label, f'must be an array with at least {minimum} item(s)')
            return []
        result = []
        for index, item in enumerate(value):
            if not isinstance(item, str) or not item.strip():
                error(f'{label}[{index}]', 'must be a nonempty string')
            else:
                result.append(item)
        return result

    def required_text(obj: dict, keys: tuple[str, ...], label: str) -> None:
        for key in keys:
            if not isinstance(obj.get(key), str) or not obj[key].strip():
                error(f'{label}.{key}', 'must be a nonempty string')

    def fields(obj: dict, allowed: set[str], label: str) -> None:
        if obj.keys() - allowed:
            error(label, 'contains unsupported fields')

    def source(value, label: str, repo_id=None) -> Path | None:
        if multi and (not isinstance(repo_id, str) or repo_id not in roots):
            error(label, 'must reference a configured repoId')
            return None
        if not isinstance(value, str) or not value or '\\' in value:
            error(label, 'must be a project-relative path using /')
            return None
        try:
            path = resolve_source(roots[repo_id] if multi else root, value)
        except (AtlasError, ValueError, OSError):
            error(label, 'source path escapes project root or is invalid')
            return None
        patterns = ['**/.env*', '**/*secrets*', '**/*.pfx', '**/*.pem', '**/*.key', *exclude]
        if any(fnmatch.fnmatch(value.lower(), p.lower()) or (p.startswith('**/') and fnmatch.fnmatch(value.lower(), p[3:].lower())) for p in patterns):
            error(label, 'source is excluded; it was not read')
            return None
        if not path.is_file():
            error(label, 'source file is missing')
            return None
        return path

    def evidence(value, label: str, minimum: int = 0) -> None:
        if not isinstance(value, list) or len(value) < minimum:
            error(label, f'must be an array with at least {minimum} item(s)')
            return
        for index, entry in enumerate(value):
            place = f'{label}[{index}]'
            if not isinstance(entry, dict):
                error(place, 'must be an object')
                continue
            fields(entry, {'file', 'symbol', 'role'} | ({'repoId'} if multi else set()), place)
            if entry.get('role') not in ('screen', 'api', 'logic', 'data', 'config'):
                error(place + '.role', 'invalid evidence role')
            path = source(entry.get('file'), place + '.file', entry.get('repoId'))
            symbol = entry.get('symbol')
            if 'symbol' in entry and (not isinstance(symbol, str) or not symbol.strip()):
                error(place + '.symbol', 'must be a nonempty string')
            elif path:
                key = (path, symbol)
                if key not in symbol_cache:
                    symbol_cache[key] = find_symbol_line(path, symbol)
                if symbol_cache[key] is None:
                    error(place + '.symbol', 'symbol was not found in source declarations')

    def rules(value, label):
        nonlocal legacy_rules, uncertain_rules
        if not isinstance(value, list):
            error(label, 'must be an array')
            return
        for index, rule in enumerate(value):
            place = f'{label}[{index}]'
            if isinstance(rule, str):
                if not rule.strip():
                    error(place, 'must be a nonempty string')
                legacy_rules += 1
                continue
            if not isinstance(rule, dict):
                error(place, 'must be a legacy string or structured rule')
                continue
            fields(rule, {'id', 'text', 'status', 'reason', 'evidence', 'dependsOn'}, place)
            required_text(rule, ('id', 'text', 'status'), place)
            identifier = rule.get('id')
            if not isinstance(identifier, str) or not re.fullmatch(_SEGMENT + r'(?:\.' + _SEGMENT + r')*', identifier):
                error(place + '.id', 'must be a stable lower-case semantic ID')
            elif identifier in rule_ids:
                error(place + '.id', 'duplicate rule ID')
            else:
                rule_ids.add(identifier)
            if rule.get('status') not in ('confirmed', 'uncertain'):
                error(place + '.status', 'must be confirmed or uncertain')
            if rule.get('status') == 'uncertain' or 'reason' in rule:
                required_text(rule, ('reason',), place)
            uncertain_rules += rule.get('status') == 'uncertain'
            evidence(rule.get('evidence'), place + '.evidence', 1)
            for dependency in strings(rule.get('dependsOn', []), place + '.dependsOn'):
                rule_dependencies.append((place, dependency))

    def node(obj: dict, depth: int, label: str) -> str | None:
        required_text(obj, ('id', 'name', 'summary'), label)
        ident = obj.get('id')
        if not isinstance(ident, str) or not re.fullmatch(_SEGMENT + (r'\.' + _SEGMENT) * (depth - 1), ident):
            error(label + '.id', f'must be a valid {depth}-segment ID')
            return None
        if ident.split('.')[0] == 'uncharted':
            error(label + '.id', 'uncharted is reserved for generated content')
        if ident in ids:
            error(label + '.id', 'duplicate node ID')
        else:
            ids[ident] = {1: 'country', 2: 'city', 3: 'town'}[depth]
        for dependency in strings(obj.get('dependsOn', []), label + '.dependsOn'):
            dependencies.append((label, dependency, {'country', 'city'} if depth == 2 else None))
        return ident

    config = load(atlas / 'config.json') or {}
    multi = config.get('version') == 2
    if config.get('version') not in (1, 2) or isinstance(config.get('version'), bool):
        error('config.json.version', 'must be 1 or 2')
    if multi:
        from .repositories import repository_roots
        try:
            roots = repository_roots(config, root)
        except (AtlasError, ValueError, OSError, TypeError):
            error('config.json.repositories', 'must describe unique Git roots within the workspace')
    required_text(config, ('projectRoot', 'language'), 'config.json')
    if 'projectName' in config:
        required_text(config, ('projectName',), 'config.json')
    exclude = strings(config.get('exclude', []), 'config.json.exclude')
    parts = config.get('parts')
    names: set = set()
    has_backend = False
    if not isinstance(parts, list) or (not parts and not multi):
        error('config.json.parts', 'must contain at least one project part')
        parts = []
    for index, part in enumerate(parts):
        label = f'config.json.parts[{index}]'
        if not isinstance(part, dict):
            error(label, 'must be an object')
            continue
        required_text(part, ('name', 'path', 'kind', 'framework'), label)
        name = part.get('name')
        repo_id = part.get('repoId')
        if multi and (not isinstance(repo_id, str) or repo_id not in roots):
            error(label + '.repoId', 'must reference a configured repository')
        if isinstance(name, str) and (not multi or isinstance(repo_id, str)):
            scoped_name = (repo_id, name) if multi else name
            if scoped_name in names:
                error(label + '.name', 'duplicate part name')
            names.add(scoped_name)
        if part.get('kind') not in ('frontend', 'backend', 'generic'):
            error(label + '.kind', 'must be frontend, backend or generic')
        has_backend |= part.get('kind') == 'backend'
        if part.get('framework') not in ('react', 'vue', 'aspnetcore', 'fastapi', 'flask', 'django', 'generic'):
            error(label + '.framework', 'unsupported framework')
        elif multi and part.get('framework') not in {'frontend': ('react', 'vue'), 'backend': ('aspnetcore', 'fastapi', 'flask', 'django'), 'generic': ('generic',)}.get(part.get('kind'), ()):
            error(label + '.framework', 'framework does not match part kind')
        try:
            value = part.get('path')
            if not isinstance(value, str) or '\\' in value:
                raise ValueError()
            if not resolve_source(roots.get(repo_id, root) if multi else root, value).is_dir():
                error(label + '.path', 'part directory is missing')
        except (AtlasError, ValueError, OSError):
            error(label + '.path', 'must be a directory within project root')
        if 'pageDirs' in part:
            for index2, directory in enumerate(strings(part['pageDirs'], label + '.pageDirs')):
                try:
                    resolve_source(roots.get(repo_id, root) if multi else root, directory)
                except (AtlasError, ValueError, OSError):
                    error(f'{label}.pageDirs[{index2}]', 'directory escapes project root')
        if 'apiPrefix' in part and not isinstance(part['apiPrefix'], str):
            error(label + '.apiPrefix', 'must be a string')

    def reference(value, label: str) -> tuple[str, str, str] | None:
        if not isinstance(value, dict):
            error(label, 'must be a scoped reference with repoId, part and key')
            return None
        fields(value, {'repoId', 'part', 'key'}, label)
        required_text(value, ('repoId', 'part', 'key'), label)
        if any(not isinstance(value.get(key), str) for key in ('repoId', 'part', 'key')):
            return None
        if (value['repoId'], value['part']) not in names:
            error(label, 'must reference a configured repository and part')
            return None
        return value['repoId'], value['part'], value['key']

    if multi:
        for index, part in enumerate(parts):
            if not isinstance(part, dict) or 'apiTargets' not in part:
                continue
            targets = part['apiTargets']
            if part.get('kind') != 'frontend' or not isinstance(targets, list) or not targets:
                error(f'config.json.parts[{index}].apiTargets', 'must contain scoped API targets')
                continue
            for target in targets:
                if not isinstance(target, dict) or set(target) != {'repoId', 'part'} or not all(isinstance(target.get(key), str) for key in ('repoId', 'part')) or not any(isinstance(candidate, dict) and candidate.get('repoId') == target['repoId'] and candidate.get('name') == target['part'] and candidate.get('kind') == 'backend' for candidate in parts):
                    error(f'config.json.parts[{index}].apiTargets', 'must reference a configured backend repository and part')

    inventory_error_start = len(errors)
    inventory = load(atlas / 'inventory.json') or {}
    if inventory.get('version') != (2 if multi else 1) or isinstance(inventory.get('version'), bool):
        error('inventory.json.version', 'must match config version')
    if multi:
        versions = inventory.get('repositories')
        if not isinstance(versions, dict) or set(versions) != set(roots):
            error('inventory.json.repositories', 'must contain exactly the configured repositories')
        elif any(not isinstance(value, dict) or not isinstance(value.get('commit'), str) or not value['commit'] or not isinstance(value.get('sourceSnapshot'), str) or not value['sourceSnapshot'] for value in versions.values()):
            error('inventory.json.repositories', 'each source needs a commit and sourceSnapshot')
    elif not isinstance(inventory.get('commit'), str):
        error('inventory.json.commit', 'must be a string')
    items = inventory.get('items', [])
    if not isinstance(items, list) or 'items' not in inventory:
        error('inventory.json.items', 'must be an array')
        items = []
    valid_items: list[dict] = []
    for index, item in enumerate(items):
        label = f'inventory.json.items[{index}]'
        if not isinstance(item, dict):
            error(label, 'must be an object')
            continue
        required_text(item, ('kind', 'key', 'part', 'file', 'source'), label)
        kind, key = item.get('kind'), item.get('key')
        if kind not in ('endpoint', 'route', 'page', 'api-call'):
            error(label + '.kind', 'invalid inventory kind')
        if not isinstance(key, str):
            continue
        if kind in ('endpoint', 'api-call') and not _ENDPOINT.fullmatch(key):
            error(label + '.key', 'invalid HTTP method/path')
        if kind == 'route' and not key.startswith('/'):
            error(label + '.key', 'route must start with /')
        repo_id = item.get('repoId')
        if not isinstance(item.get('part'), str) or (multi and not isinstance(repo_id, str)) or ((repo_id, item['part']) if multi else item['part']) not in names:
            error(label + '.part', 'must reference a configured part')
        line = item.get('line')
        if not isinstance(line, int) or isinstance(line, bool) or line < 1:
            error(label + '.line', 'must be a positive integer')
        source(item.get('file'), label + '.file', repo_id)
        if kind == 'page':
            source(key, label + '.key', repo_id)
        if multi and 'pairedWith' in item:
            reference(item['pairedWith'], label + '.pairedWith')
        valid_items.append(item)
    inventory_valid = len(errors) == inventory_error_start
    analysis = inventory.get('businessAnalysis')
    if analysis is not None:
        if not isinstance(analysis, dict):
            error('inventory.json.businessAnalysis', 'must be an object')
        else:
            files = analysis.get('files')
            if not isinstance(files, list):
                error('inventory.json.businessAnalysis.files', 'must be an array')
                files = []
            for index, entry in enumerate(files):
                place = f'inventory.json.businessAnalysis.files[{index}]'
                if not isinstance(entry, dict):
                    error(place, 'must be an object')
                    continue
                if entry.get('status') not in ('parsed', 'excluded', 'unsupported', 'error', 'unavailable'):
                    error(place + '.status', 'invalid analysis status')
                if entry.get('status') != 'excluded':
                    source(entry.get('file'), place + '.file', entry.get('repoId'))
            candidates = analysis.get('candidates', [])
            if isinstance(candidates, list):
                for index, entry in enumerate(candidates):
                    place = f'inventory.json.businessAnalysis.candidates[{index}]'
                    if isinstance(entry, dict):
                        source(entry.get('file'), place + '.file', entry.get('repoId'))
                        if 'line' in entry:
                            error(place, 'business candidates must not store line numbers')

    nodes_dir = atlas / 'nodes'
    if nodes_dir.exists() and not nodes_dir.resolve().is_relative_to(atlas):
        error('nodes', 'document path escapes atlas directory')
        documents = []
    else:
        documents = sorted(nodes_dir.rglob('*.json')) if nodes_dir.exists() else []
    countries: dict[str, tuple[dict, str]] = {}
    cities: dict[str, tuple[dict, str]] = {}
    for path in documents:
        label = path.relative_to(atlas).as_posix()
        obj = load(path)
        if obj is None:
            continue
        relative = path.relative_to(nodes_dir)
        if len(relative.parts) != 2:
            error(label, 'node document must be directly inside its country directory')
        if path.name == '_country.json':
            fields(obj, {'id', 'name', 'summary', 'actors', 'cities'}, label)
            ident = node(obj, 1, label)
            if ident and path.parent.name != ident:
                error(label + '.id', 'country ID must match its directory')
            city_ids = strings(obj.get('cities'), label + '.cities')
            if len(city_ids) != len(set(city_ids)):
                error(label + '.cities', 'duplicate city reference')
            strings(obj.get('actors', []), label + '.actors')
            if ident:
                countries[ident] = (obj, label)
            continue
        fields(obj, {'id', 'name', 'summary', 'data', 'dependsOn', 'towns'}, label)
        ident = node(obj, 2, label)
        if ident and (ident.split('.')[0] != path.parent.name or ident.split('.')[-1] != path.stem):
            error(label + '.id', 'city ID must match country directory and filename')
        if ident:
            cities[ident] = (obj, label)
        strings(obj.get('data', []), label + '.data')
        entries = obj.get('towns')
        if not isinstance(entries, list) or not entries:
            error(label + '.towns', 'must contain at least one town')
            continue
        for index, town in enumerate(entries):
            place = f'{label}.towns[{index}]'
            if not isinstance(town, dict):
                error(place, 'must be an object')
                continue
            fields(town, {'id', 'name', 'type', 'summary', 'rules', 'residents', 'screens', 'endpoints', 'evidence', 'dependsOn', 'reads', 'writes'}, place)
            node(town, 3, place)  # Stable IDs may keep their original city prefix after a move.
            if town.get('type') not in ('operation', 'job', 'rule'):
                error(place + '.type', 'invalid town type')
            # Data names the town reads or writes; the viewer matches them exactly across cities.
            for field in ('reads', 'writes'):
                data_names = strings(town.get(field, []), f'{place}.{field}')
                if len(data_names) != len(set(data_names)):
                    error(f'{place}.{field}', 'duplicate data name')
                if any(name != name.strip() for name in data_names):
                    error(f'{place}.{field}', 'data names must not start or end with spaces')
            rules(town.get('rules', []), place + '.rules')
            if multi:
                for field in ('screens', 'endpoints'):
                    refs = town.get(field, [])
                    if not isinstance(refs, list):
                        error(place + '.' + field, 'must be an array')
                        continue
                    seen_refs: set[tuple[str, str, str]] = set()
                    for ref_index, ref in enumerate(refs):
                        ref_label = f'{place}.{field}[{ref_index}]'
                        parsed = reference(ref, ref_label)
                        if not parsed:
                            continue
                        if parsed in seen_refs:
                            error(ref_label, 'duplicate scoped reference')
                        seen_refs.add(parsed)
                        repo_id, _, key = parsed
                        if field == 'screens' and not key.startswith('/'):
                            source(key, ref_label, repo_id)
                        elif field == 'endpoints' and (not _ENDPOINT.fullmatch(key) or (key.endswith('/') and not key.endswith(' /')) or re.search(r'\{[^}]*:|\$\{|/:|/\$', key)):
                            error(ref_label, 'use METHOD /path with untyped {parameter} and no trailing /')
            else:
                for screen in strings(town.get('screens', []), place + '.screens'):
                    if not screen.startswith('/'):
                        source(screen, place + '.screens')
                for endpoint in strings(town.get('endpoints', []), place + '.endpoints'):
                    if not _ENDPOINT.fullmatch(endpoint) or (endpoint.endswith('/') and not endpoint.endswith(' /')) or re.search(r'\{[^}]*:|\$\{|/:|/\$', endpoint):
                        error(place + '.endpoints', 'use METHOD /path with untyped {parameter} and no trailing /')
            evidence(town.get('evidence'), place + '.evidence', 1)
            residents = town.get('residents', [])
            if not isinstance(residents, list):
                error(place + '.residents', 'must be an array')
                residents = []
            resident_names: set[str] = set()
            for index2, resident in enumerate(residents):
                resident_place = f'{place}.residents[{index2}]'
                if not isinstance(resident, dict):
                    error(resident_place, 'must be an object')
                    continue
                fields(resident, {'name', 'rules', 'evidence'}, resident_place)
                required_text(resident, ('name',), resident_place)
                name = resident.get('name')
                if isinstance(name, str):
                    if name in resident_names:
                        error(resident_place + '.name', 'duplicate resident name in town')
                    resident_names.add(name)
                rules(resident.get('rules', []), resident_place + '.rules')
                if 'evidence' in resident:
                    evidence(resident['evidence'], resident_place + '.evidence')
            towns.append(town)

    for ident, (country, label) in countries.items():
        listed = country.get('cities', [])
        if not isinstance(listed, list):
            continue
        actual = {city for city in cities if city.split('.')[0] == ident}
        if set(item for item in listed if isinstance(item, str)) != actual:
            error(label + '.cities', 'must list exactly the city documents in this country')
    for ident, (_, label) in cities.items():
        if ident.split('.')[0] not in countries:
            error(label, 'parent country document is missing')
    for label, dependency, allowed in dependencies:
        if dependency not in ids or (allowed and ids[dependency] not in allowed):
            error(label + '.dependsOn', 'dependency does not reference an allowed existing node')

    for label, dependency in rule_dependencies:
        if dependency not in rule_ids:
            error(label + '.dependsOn', 'dependency does not reference an existing rule ID')
    if rule_ids & ids.keys():
        error('nodes.rules', 'rule IDs must not collide with node IDs')

    review_path = atlas / 'rule-review.json'
    business_review = review_candidates(inventory.get('businessAnalysis'), load(review_path, False),
                                        rule_ids, legacy_rules, error, warnings, review_path.exists())
    business_review['uncertainRuleCount'] = uncertain_rules
    if uncertain_rules:
        warnings.append(f'{uncertain_rules} structured business rule(s) remain uncertain; see each rule reason')

    overrides = load(atlas / 'overrides.json', False)
    if overrides is not None:
        fields(overrides, {'rename', 'summary', 'move', 'hide'}, 'overrides.json')
        for field in ('rename', 'summary', 'move'):
            mapping = overrides.get(field, {})
            if not isinstance(mapping, dict):
                error('overrides.json.' + field, 'must be an object')
                continue
            for index, (ident, value) in enumerate(mapping.items()):
                label = f'overrides.json.{field}[{index}]'
                if ident not in ids:
                    error(label, 'target node does not exist')
                if not isinstance(value, str) or not value.strip():
                    error(label, 'must contain a nonempty string')
                if field == 'move' and (ids.get(ident) != 'town' or not isinstance(value, str) or ids.get(value) != 'city'):
                    error(label, 'move must map an existing town to an existing city')
        for ident in strings(overrides.get('hide', []), 'overrides.json.hide'):
            if ident not in ids:
                error('overrides.json.hide', 'target node does not exist')
    glossary = load(atlas / 'glossary.json', False)
    if glossary is not None:
        terms = glossary.get('terms')
        if not isinstance(terms, dict) or any(not isinstance(v, str) for v in terms.values()):
            error('glossary.json.terms', 'must map terms to strings')

    endpoint_refs: set = set()
    screen_refs: set = set()
    file_refs: set = set()
    def scoped_key(value, endpoint=False):
        if multi:
            if not isinstance(value, dict) or any(not isinstance(value.get(key), str) for key in ('repoId', 'part', 'key')):
                return None
            return value['repoId'], value['part'], (_endpoint_key(value['key']) if endpoint else _normalize_path(value['key']))
        return (_endpoint_key(value) if endpoint else _normalize_path(value)) if isinstance(value, str) else None

    for town in towns:
        if isinstance(town.get('endpoints', []), list):
            endpoint_refs.update(key for value in town.get('endpoints', []) if (key := scoped_key(value, True)) is not None)
        if isinstance(town.get('screens', []), list):
            screen_refs.update(key for value in town.get('screens', []) if (key := scoped_key(value)) is not None)
        entries = [entry for owner in rule_owners(town) if isinstance(owner.get('evidence', []), list) for entry in owner.get('evidence', [])]
        file_refs.update((entry['repoId'], entry['file']) if multi else entry['file'] for entry in entries if isinstance(entry, dict) and isinstance(entry.get('file'), str) and (not multi or isinstance(entry.get('repoId'), str)))
    available = {scoped_key(item if multi else item['key'], True) for item in valid_items if item.get('kind') in (('endpoint', 'api-call') if multi else ('endpoint' if has_backend else 'api-call',))}
    for ref in endpoint_refs:
        if ref not in available:
            error('nodes.endpoints', 'endpoint does not exist in scanned backend endpoints' if has_backend else 'external API does not exist in scanned API calls')
    if multi:
        available_screens = {scoped_key(item) for item in valid_items if item.get('kind') in ('route', 'page')}
        if screen_refs - available_screens:
            error('nodes.screens', 'screen does not exist in the referenced repository and part inventory')
        endpoints = {scoped_key(item, True) for item in valid_items if item.get('kind') == 'endpoint'}
        for item in valid_items:
            if 'pairedWith' in item and scoped_key(item['pairedWith'], True) not in endpoints:
                error('inventory.json.pairedWith', 'paired endpoint does not exist in the referenced repository and part')
    required = [item for item in valid_items if item.get('kind') in ('endpoint', 'route', 'page')]
    uncharted = []
    for item in required:
        kind, key = item['kind'], item['key']
        covered = (scoped_key(item if multi else key, True) in endpoint_refs if kind == 'endpoint' else scoped_key(item if multi else key) in screen_refs or (kind == 'page' and ((item.get('repoId'), key) if multi else key) in file_refs))
        if not covered:
            uncharted.append(item)
    total, covered = len(required), len(required) - len(uncharted)
    if uncharted:
        warnings.append(f'{len(uncharted)} inventory item(s) are uncharted')
    # CLI prints this report as JSON. Do not copy a sensitive inventory value
    # back into its uncharted list after correctly flagging it above.
    sensitive_inventory = any(message.startswith('inventory.json') and 'possible secret' in message for message in errors)
    report = {'valid': not errors, 'errors': errors, 'warnings': warnings,
            'coverage': {'total': total, 'covered': covered, 'percent': (round(covered * 100 / total, 2) if total else 100.0) if inventory_valid else 0.0},
            'uncharted': [] if sensitive_inventory else uncharted, 'businessReview': business_review}
    if multi:
        report['coverageByRepository'] = {}
        for repo_id in roots:
            repo_total = sum(item.get('repoId') == repo_id for item in required)
            repo_covered = repo_total - sum(item.get('repoId') == repo_id for item in uncharted)
            report['coverageByRepository'][repo_id] = {'total': repo_total, 'covered': repo_covered,
                'percent': (round(repo_covered * 100 / repo_total, 2) if repo_total else 100.0) if inventory_valid else 0.0}
    return report
