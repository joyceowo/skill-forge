"""Git-scoped project discovery and deterministic inventory generation."""
from fnmatch import fnmatchcase
from pathlib import Path, PurePosixPath
import re

from .common import AtlasError, git_commit, git_files, load_context, read_json, resolve_source, write_json
from .scanner_util import pair_key


DEFAULT_EXCLUDE = [
    '**/.env*', '**/*secrets*', '**/*.pfx', '**/*.pem', '**/*.key',
    '**/Migrations/**', '**/node_modules/**', '**/bin/**', '**/obj/**',
    '**/dist/**', '**/build/**', '**/.atlas/**', '**/__pycache__/**',
    '**/tests/**', '**/test/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*',
    '**/test_*.py', '**/*_test.py', '**/*Tests.cs', '**/*Test.cs',
]


def excluded(file, patterns):
    file = file.replace('\\', '/').lower()
    for pattern in patterns:
        pattern = pattern.replace('\\', '/').lower()
        if fnmatchcase(file, pattern) or (pattern.startswith('**/') and fnmatchcase(file, pattern[3:])):
            return True
    return False


def in_part(file, part_path):
    part_path = part_path.removeprefix('./').rstrip('/')
    if part_path == '.':
        part_path = ''
    return not part_path or file == part_path or file.startswith(part_path + '/')


def _validate_config(config, root):
    from .repositories import repository_roots
    if config.get('version') not in (1, 2) or isinstance(config.get('version'), bool):
        raise AtlasError('config.json version must be 1 or 2.')
    multi = config['version'] == 2
    roots = repository_roots(config, root) if multi else {'default': root}
    if 'projectName' in config and (not isinstance(config['projectName'], str) or not config['projectName'].strip()):
        raise AtlasError('config.json projectName must be a nonempty string.')
    if not isinstance(config.get('parts'), list) or (not config['parts'] and not config.get('_repositorySettings') and not multi):
        raise AtlasError('config.json parts must be a nonempty array.')
    frameworks = {'frontend': {'react', 'vue'}, 'backend': {'aspnetcore', 'fastapi', 'flask', 'django'},
                  'generic': {'generic'}}
    names = set()
    for part in config['parts']:
        if not isinstance(part, dict) or any(not isinstance(part.get(key), str) or not part[key]
                                             for key in ('name', 'path', 'kind', 'framework')):
            raise AtlasError('Each config part requires nonempty name, path, kind, and framework strings.')
        repo_id = part.get('repoId') if multi else 'default'
        if not isinstance(repo_id, str) or repo_id not in roots:
            raise AtlasError('Each v2 part requires a configured repoId.')
        if (repo_id, part['name']) in names:
            raise AtlasError('config.json part names must be unique.')
        names.add((repo_id, part['name']))
        if part['framework'] not in frameworks.get(part['kind'], set()):
            raise AtlasError('Unsupported config part kind/framework: ' + part['name'])
        resolve_source(roots[repo_id], part['path'])
        if not isinstance(part.get('apiPrefix', ''), str):
            raise AtlasError('config part apiPrefix must be a string.')
        directories = part.get('pageDirs', [])
        if not isinstance(directories, list) or any(not isinstance(directory, str) for directory in directories):
            raise AtlasError('config part pageDirs must be an array of relative paths.')
        for directory in directories:
            resolve_source(roots[repo_id], directory)
        targets = part.get('apiTargets')
        if targets is not None and multi:
            if (part['kind'] != 'frontend' or not isinstance(targets, list) or not targets
                    or any(not isinstance(target, dict) or set(target) != {'repoId', 'part'}
                           or not any(isinstance(candidate, dict) and candidate.get('repoId') == target.get('repoId')
                                      and candidate.get('name') == target.get('part')
                                      and candidate.get('kind') == 'backend' for candidate in config['parts'])
                           for target in targets)):
                raise AtlasError('apiTargets must name configured backend repoId/part pairs.')
    exclusions = config.get('exclude', [])
    if not isinstance(exclusions, list) or any(not isinstance(pattern, str) for pattern in exclusions):
        raise AtlasError('config.json exclude must be an array of glob strings.')


def _discover_parts(root):
    files = [f for f in git_files(root) if not excluded(f, DEFAULT_EXCLUDE)]
    candidates = {}
    for file in files:
        path = PurePosixPath(file)
        parent = str(path.parent)
        framework, kind = None, None
        if path.name == 'package.json':
            manifest = read_json(resolve_source(root, file))
            dependencies = {**manifest.get('dependencies', {}), **manifest.get('devDependencies', {})}
            framework = next((name for name in ('react', 'vue') if name in dependencies), None)
            kind = 'frontend'
        elif path.suffix == '.csproj':
            framework, kind = 'aspnetcore', 'backend'
        elif path.name in ('requirements.txt', 'pyproject.toml'):
            content = resolve_source(root, file).read_text(encoding='utf-8-sig')
            framework = next((name for name in ('fastapi', 'flask', 'django')
                              if re.search(r'(?im)^\s*(?:[\"\']|\[)?' + name + r'\b', content)
                              or re.search(r'[\"\']' + name + r'(?:[>=<!~\[\"\'])', content, re.I)), None)
            kind = 'backend'
        if framework:
            candidates[(parent, kind)] = framework
    parts, names = [], set()
    for (path, kind), framework in sorted(candidates.items()):
        name = PurePosixPath(path).name if path != '.' else ('web' if kind == 'frontend' else 'api')
        base, number = name, 2
        while name in names:
            name = f'{base}-{number}'
            number += 1
        names.add(name)
        part = dict(name=name, path=path, kind=kind, framework=framework)
        if kind == 'frontend':
            part['apiPrefix'] = ''
            part['pageDirs'] = sorted({str(PurePosixPath(*PurePosixPath(f).parts[:i + 1]))
                                       for f in files if in_part(f, path)
                                       for i, component in enumerate(PurePosixPath(f).parts)
                                       if component in ('pages', 'views')})
        parts.append(part)
    if not parts:
        # Business candidates do not require an HTTP framework or manifest.
        parts.append(dict(name='source', path='.', kind='generic', framework='generic'))
    return parts


def init_project(project_root: Path, atlas_dir: Path, *, repositories: list[str] | None = None) -> dict:
    from .repositories import discover_repositories, repository_roots

    root, atlas = Path(project_root).resolve(), Path(atlas_dir).resolve()
    if (atlas / 'config.json').exists():
        raise AtlasError('config.json already exists; edit it explicitly instead of overwriting it.')
    entries = discover_repositories(root, repositories)
    if entries is None:
        parts = _discover_parts(root)
    else:
        roots = repository_roots({'version': 2, 'repositories': entries}, root)
        parts = [dict(part, repoId=identifier) for identifier, path in roots.items() for part in _discover_parts(path)]
    try:
        relative = root.relative_to(atlas)
        root_setting = relative.as_posix() or '.'
    except ValueError:
        root_setting = '..' if atlas.parent == root else str(root)
    config = dict(version=2 if entries else 1, projectRoot=root_setting, language='zh-Hant', parts=parts,
                  exclude=list(DEFAULT_EXCLUDE))
    if entries:
        config.update(repositories=entries, projectName=root.name)
        config['warnings'] = [f'{entry["id"]}: no supported scanner parts; analyze evidence manually.'
                              for entry in entries if not any(p['repoId'] == entry['id'] for p in parts)]
    _validate_config(config, root)
    write_json(atlas / 'config.json', config)
    return config


def scan_project(project_root: Path, atlas_dir: Path) -> dict:
    from .scanner_business import scan_business
    from .updater import source_snapshot

    config, root = load_context(Path(atlas_dir), project_root)
    _validate_config(config, root)
    if config['version'] == 2:
        return _scan_repositories(config, root, Path(atlas_dir))
    snapshot = source_snapshot(root, Path(atlas_dir), config)
    commit = git_commit(root)
    atlas = Path(atlas_dir).resolve()
    business = scan_business(config, root, atlas)
    invalid = {entry['file'] for entry in business['files'] if entry['status'] == 'error'}
    items = _scan_parts(config, root, atlas, skip_files=invalid)
    endpoints = {}
    for entry in items:
        if entry['kind'] == 'endpoint':
            endpoints.setdefault(pair_key(entry['key']), []).append(entry['key'])
    for entry in items:
        if entry['kind'] == 'api-call':
            matches = endpoints.get(pair_key(entry['key']), [])
            if not matches:
                matches = endpoints.get('ANY ' + pair_key(entry['key']).split(' ', 1)[1], [])
            if len(set(matches)) == 1:
                entry['pairedWith'] = matches[0]
    # Index routes and equivalent declarations need only one inventory entry.
    unique = {(i['kind'], i['key'], i['part'], i['file'], i.get('symbol')): i for i in reversed(items)}
    if snapshot != source_snapshot(root, Path(atlas_dir), config) or commit != git_commit(root):
        raise AtlasError('Source changed while scanning; run scan again after changes are stable.')
    inventory = dict(version=1, commit=commit, sourceSnapshot=snapshot, businessAnalysis=business,
                     warnings=business['warnings'],
                     items=sorted(unique.values(), key=lambda i: (i['file'], i['line'], i['kind'], i['key'])))
    write_json(Path(atlas_dir) / 'inventory.json', inventory)
    return inventory


def _scan_parts(config, root, atlas, *, skip_files=frozenset()):
    from .scanner_csharp import scan_csharp
    from .scanner_frontend import scan_frontend
    from .scanner_python import scan_python

    files = [f for f in git_files(root) if f not in skip_files and not excluded(f, config.get('exclude', DEFAULT_EXCLUDE))
             and not (root / f).resolve().is_relative_to(atlas)]
    items = []
    for part in config['parts']:
        # Resolve first: even an empty configured part must not escape the project.
        resolve_source(root, part['path'])
        if part['kind'] == 'generic':
            continue
        extensions = ('.ts', '.tsx', '.js', '.jsx', '.vue') if part['kind'] == 'frontend' else (
            ('.cs',) if part['framework'] == 'aspnetcore' else ('.py',))
        sources = {}
        for file in files:
            if in_part(file, part['path']) and file.endswith(extensions):
                path = resolve_source(root, file)
                if path.is_file():
                    try:
                        sources[file] = path.read_text(encoding='utf-8-sig')
                    except UnicodeError as exc:
                        raise AtlasError(f'Cannot decode tracked source as UTF-8: {file}') from exc
        if part['kind'] == 'frontend':
            items.extend(scan_frontend(sources, part))
        elif part['framework'] == 'aspnetcore':
            items.extend(scan_csharp(sources, part))
        else:
            items.extend(scan_python(sources, part))
    return items


def _scan_repositories(config, root, atlas):
    from .repositories import repository_config, repository_roots, repository_versions
    from .scanner_business import load_engine, scan_business

    versions = repository_versions(config, root, atlas)
    items, warnings = [], []
    engine = load_engine()
    business = dict(engine=engine[1], files=[], candidates=[], warnings=[])
    for identifier, path in repository_roots(config, root).items():
        local = repository_config(config, identifier)
        if not local['parts']:
            warnings.append(f'{identifier}: no supported scanner parts; analyze evidence manually.')
        local_business = scan_business(local, path, atlas, repo_id=identifier, engine=engine)
        for key in ('files', 'candidates', 'warnings'):
            business[key].extend(local_business[key])
        invalid = {entry['file'] for entry in local_business['files'] if entry['status'] == 'error'}
        items.extend(dict(item, repoId=identifier) for item in _scan_parts(local, path, atlas, skip_files=invalid))
    endpoints = {}
    for entry in items:
        if entry['kind'] == 'endpoint':
            endpoints.setdefault(pair_key(entry['key']), []).append(entry)
    part_map = {(part['repoId'], part['name']): part for part in config['parts']}
    for entry in items:
        if entry['kind'] != 'api-call':
            continue
        key = pair_key(entry['key'])
        targets = part_map[(entry['repoId'], entry['part'])].get('apiTargets')
        def allowed(candidates):
            return [candidate for candidate in candidates if not targets or any(
                target['repoId'] == candidate['repoId'] and target['part'] == candidate['part']
                for target in targets)]
        matches = allowed(endpoints.get(key, [])) or allowed(endpoints.get('ANY ' + key.split(' ', 1)[1], []))
        unique = {(candidate['repoId'], candidate['part'], candidate['key']) for candidate in matches}
        if len(unique) == 1:
            repo_id, part, key = next(iter(unique))
            entry['pairedWith'] = dict(repoId=repo_id, part=part, key=key)
        else:
            entry['pairingWarning'] = 'ambiguous' if unique else 'no-matching-configured-endpoint'
            if unique:
                warnings.append(f"Ambiguous API target: {entry['repoId']}/{entry['part']} {entry['key']}; configure apiTargets.")
    unique = {(i['repoId'], i['kind'], i['key'], i['part'], i['file'], i.get('symbol')): i for i in reversed(items)}
    current_config, _ = load_context(atlas, root)
    if versions != repository_versions(current_config, root, atlas):
        raise AtlasError('Sources/settings changed while scanning; run scan again after changes are stable.')
    business['warnings'] = sorted(set(business['warnings']))
    warnings.extend(business['warnings'])
    inventory = dict(version=2, repositories=versions, businessAnalysis=business, warnings=sorted(set(warnings)),
                     items=sorted(unique.values(), key=lambda i: (i['repoId'], i['file'], i['line'], i['kind'], i['key'])))
    from .updater_multi import reconcile_scan_progress
    reconcile_scan_progress(atlas, versions)
    write_json(atlas / 'inventory.json', inventory)
    return inventory
