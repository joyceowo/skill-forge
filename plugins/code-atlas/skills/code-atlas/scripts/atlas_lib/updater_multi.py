"""One analysis baseline and checkpoint across independent Git repositories."""
from __future__ import annotations

from pathlib import Path

from .common import AtlasError, git_files, load_context, read_json, resolve_source, utc_now, write_json
from .repositories import parse_assignments, repository_roots, repository_versions
from .rule_model import rule_owners, owner_evidence, rule_index, rule_changes, require_review
from .updater import (_atlas_prefix, _changes, _dirty_files, _documents, _generated, _git,
                      _require_clean, _resolve_commit, document_snapshot)


def _context(project_root, atlas_dir):
    from .scanner import _validate_config

    atlas = Path(atlas_dir).resolve()
    config, root = load_context(atlas, project_root)
    _validate_config(config, root)
    _atlas_prefix(root, atlas)
    roots = repository_roots(config, root)
    return config, root, atlas, roots


def _clean(roots, atlas):
    for identifier, path in roots.items():
        try:
            _require_clean(path, _atlas_prefix(path, atlas))
        except AtlasError as exc:
            raise AtlasError(f'{identifier}: {exc}') from exc


def _versions(config, root, atlas):
    versions = repository_versions(config, root, atlas)
    if any(not entry['commit'] for entry in versions.values()):
        raise AtlasError('Every configured repository requires a committed HEAD.')
    return versions


def _state(atlas):
    path = atlas / 'state.json'
    if not path.exists():
        return None
    value = read_json(path)
    if (not isinstance(value, dict) or value.get('version') != 2 or not isinstance(value.get('repositories'), dict)
            or not value['repositories'] or any(not isinstance(entry, dict)
                or not isinstance(entry.get('baseCommit'), str) or not entry['baseCommit']
                for entry in value['repositories'].values())):
        raise AtlasError('Invalid v2 state; reconcile source IDs or specify --since-repo ID=SHA for each source.')
    return value


def _progress(atlas):
    path = atlas / 'progress.json'
    if not path.exists():
        return None
    value = read_json(path)
    if (not isinstance(value, dict) or value.get('version') != 2 or value.get('mode') not in ('init', 'update')
            or not isinstance(value.get('repositories'), dict) or not isinstance(value.get('countries'), list)):
        raise AtlasError('v2 progress requires mode, repositories version vector, and countries.')
    seen = set()
    for country in value['countries']:
        if (not isinstance(country, dict) or not isinstance(country.get('id'), str) or not country['id']
                or country.get('status') not in ('pending', 'in-progress', 'done') or country['id'] in seen):
            raise AtlasError('Progress countries require unique IDs and pending/in-progress/done status.')
        seen.add(country['id'])
    return value


def reconcile_scan_progress(atlas, versions):
    """Never carry completed work into a different source/settings version."""
    progress = _progress(atlas)
    if progress is not None and progress['repositories'] != versions:
        progress['repositories'] = versions
        progress['mode'] = 'update'
        for country in progress['countries']:
            country['status'] = 'pending'
        write_json(atlas / 'progress.json', progress)


def _require_progress(atlas, versions):
    progress = _progress(atlas)
    if progress is not None:
        if progress['repositories'] != versions:
            raise AtlasError('Progress version vector is stale; run scan and review every country before finish.')
        if any(country['status'] != 'done' for country in progress['countries']):
            raise AtlasError('Analysis progress is incomplete; finish every country before advancing baselines.')
        countries = {read_json(path).get('id') for path in (atlas / 'nodes').glob('*/_country.json')}
        if {country['id'] for country in progress['countries']} != countries:
            raise AtlasError('Progress countries must match the authored countries; reconcile progress before finish.')


def _require_inventory(atlas, versions):
    inventory = read_json(atlas / 'inventory.json')
    if not isinstance(inventory, dict) or inventory.get('version') != 2 or inventory.get('repositories') != versions:
        raise AtlasError('Inventory/source/settings are stale; run scan and review all sources before finish/export.')
    return inventory


def _recheck(config, root, atlas, roots, versions, documents=None):
    _clean(roots, atlas)
    current_config, _ = load_context(atlas, root)
    if current_config != config or _versions(current_config, root, atlas) != versions:
        raise AtlasError('Sources/settings changed during verification; no baseline was advanced.')
    if documents is not None and document_snapshot(atlas) != documents:
        raise AtlasError('Analysis documents changed during verification; retry after review.')


def finish_atlas(project_root, atlas_dir):
    from .validator import validate_atlas

    config, root, atlas, roots = _context(project_root, atlas_dir)
    _clean(roots, atlas)
    versions = _versions(config, root, atlas)
    _require_inventory(atlas, versions)
    _require_progress(atlas, versions)
    documents = document_snapshot(atlas)
    report = validate_atlas(root, atlas)
    if not report['valid']:
        raise AtlasError('Validation failed; resolve errors before finish. No repository baseline changed.')
    require_review(report)
    rules_snapshot = rule_index(atlas)
    _recheck(config, root, atlas, roots, versions, documents)
    repositories = {}
    for identifier, path in roots.items():
        branch = _git(path, 'symbolic-ref', '--short', '-q', 'HEAD', optional=True)
        repositories[identifier] = {'baseCommit': versions[identifier]['commit'],
                                    'sourceSnapshot': versions[identifier]['sourceSnapshot'],
                                    'branch': branch.strip() if branch else '(detached)'}
    # Branch lookup is also bounded by the same complete vector check.
    _recheck(config, root, atlas, roots, versions, documents)
    state = dict(version=2, repositories=repositories, analyzedAt=utc_now(), documentsSnapshot=documents, ruleIndex=rules_snapshot)
    write_json(atlas / 'state.json', state)
    return {'state': state, 'coverage': report['coverage'], 'uncharted': report['uncharted'], 'warnings': report['warnings'], 'businessReview': report['businessReview']}


def verify_finished_atlas(project_root, atlas_dir):
    config, root, atlas, roots = _context(project_root, atlas_dir)
    _clean(roots, atlas)
    versions = _versions(config, root, atlas)
    state = _state(atlas)
    if (not state or set(state['repositories']) != set(versions)
            or any(state['repositories'][key].get('baseCommit') != item['commit']
                   or state['repositories'][key].get('sourceSnapshot') != item['sourceSnapshot']
                   for key, item in versions.items())):
        raise AtlasError('Export requires finish at the current complete repository version vector.')
    _require_inventory(atlas, versions)
    _require_progress(atlas, versions)
    documents = document_snapshot(atlas)
    if state.get('documentsSnapshot') != documents:
        raise AtlasError('Analysis documents changed; validate and finish before export.')
    _recheck(config, root, atlas, roots, versions, documents)
    return versions, documents


def _references(town, roots, parts):
    for owner in rule_owners(town):
        for entry in owner.get('evidence', []):
            if entry.get('repoId') not in roots:
                raise AtlasError('Evidence has an unknown/missing repoId; reconcile sources before diff.')
            resolve_source(roots[entry['repoId']], entry['file'])
    for field in ('screens', 'endpoints'):
        entries = town.get(field, [])
        if not isinstance(entries, list):
            raise AtlasError(f'Town {field} must be scoped references.')
        for entry in entries:
            if (not isinstance(entry, dict) or not isinstance(entry.get('key'), str)
                    or (entry.get('repoId'), entry.get('part')) not in parts):
                raise AtlasError(f'Town {field} require known repoId/part/key references.')
            if field == 'screens' and not entry['key'].startswith('/'):
                resolve_source(roots[entry['repoId']], entry['key'])


def diff_atlas(project_root, atlas_dir, *, since=None, since_repositories=None):
    if since is not None:
        raise AtlasError('Multiple Git sources require --since-repo ID=SHA, not --since.')
    config, root, atlas, roots = _context(project_root, atlas_dir)
    overrides = parse_assignments(since_repositories, '--since-repo')
    if set(overrides) - set(roots):
        raise AtlasError('--since-repo contains an unknown repository ID.')
    _clean(roots, atlas)
    versions = _versions(config, root, atlas)
    state = _state(atlas) if set(overrides) != set(roots) else None
    if state and set(state['repositories']) != set(roots):
        raise AtlasError('Configured repository IDs changed; reconcile sources and provide all baselines explicitly.')
    repositories, changes, warnings, manual = {}, [], [], []
    renames = {}
    for identifier, path in roots.items():
        revision = overrides.get(identifier) or (state or {}).get('repositories', {}).get(identifier, {}).get('baseCommit')
        base = _resolve_commit(path, revision) if revision else None
        if not base:
            raise AtlasError(f'{identifier}: missing/unavailable baseline; use --since-repo {identifier}=SHA or finish a full analysis.')
        head = versions[identifier]['commit']
        prefix = _atlas_prefix(path, atlas)
        local = [dict(change, repoId=identifier) for change in _changes(path, base, head, prefix)]
        renamed = [change for change in local if change['status'] == 'R']
        old_paths, new_paths = {change['oldPath'] for change in renamed}, {change['path'] for change in renamed}
        for change in renamed:
            if change['oldPath'] in new_paths or change['path'] in old_paths:
                manual.append(change)
            else:
                renames[(identifier, change['oldPath'])] = change['path']
        baseline_files = _git(path, 'ls-tree', '-r', '--name-only', '-z', base, '--', '.').split('\0')
        denominator = max(sum(bool(file) and not _generated(file, prefix) for file in baseline_files),
                          sum(not _generated(file, prefix) for file in git_files(path)), 1)
        ratio = len(local) / denominator
        if ratio > .3:
            warnings.append(f'{identifier}: more than 30% of tracked files changed; consider a full analysis.')
        repositories[identifier] = dict(baseCommit=base, headCommit=head, changeRatio=round(ratio, 4),
                                        changedFiles=len(local), recommendFullAnalysis=ratio > .3)
        changes.extend(local)
    if manual:
        warnings.append('Overlapping rename paths require manual evidence/screens review; those paths were not rewritten.')
    documents = _documents(atlas, multi=True)
    document_fingerprint = document_snapshot(atlas)
    parts = {(part['repoId'], part['name']) for part in config['parts']}
    by_file = {}
    for change in changes:
        for file in {change['path'], change.get('oldPath', change['path'])}:
            by_file.setdefault((change['repoId'], file), []).append(change)
    # Inventory connects callers to endpoints. A stale previous inventory is useful
    # for impact review, but it cannot authorize finish or suppress source changes.
    inventory = read_json(atlas / 'inventory.json') if (atlas / 'inventory.json').exists() else {}
    entries = inventory.get('items', []) if isinstance(inventory, dict) else []
    endpoint_changes = {}
    for item in entries:
        if not isinstance(item, dict) or item.get('kind') != 'endpoint':
            continue
        matches = by_file.get((item.get('repoId'), item.get('file')), [])
        if matches:
            endpoint_changes[(item.get('repoId'), item.get('part'), item.get('key'))] = matches
    for item in entries:
        paired = item.get('pairedWith') if isinstance(item, dict) else None
        if not isinstance(paired, dict):
            continue
        matches = endpoint_changes.get((paired.get('repoId'), paired.get('part'), paired.get('key')), [])
        if matches:
            by_file.setdefault((item.get('repoId'), item.get('file')), []).extend(matches)
    affected, rewrites, references, towns, hierarchy = {}, [], {}, {}, {}
    for path, document, original in documents:
        country_path = path.parent / '_country.json'
        country_document = read_json(country_path) if country_path.exists() else {}
        if not isinstance(country_document, dict) or not isinstance(country_document.get('id', ''), str):
            raise AtlasError('Country documents require an ID; repair them before diff.')
        country = country_document.get('id')
        if not isinstance(document.get('id', ''), str):
            raise AtlasError('City documents require an ID; repair them before diff.')
        for owner in [document, *document['towns']]:
            if (not isinstance(owner.get('dependsOn', []), list)
                    or any(not isinstance(value, str) for value in owner.get('dependsOn', []))):
                raise AtlasError('Dependencies must be node ID strings; repair them before diff.')
        changed = False
        for town in document['towns']:
            _references(town, roots, parts)
            towns[town['id']] = (town, document, path)
            hierarchy[town['id']] = {town['id'], document.get('id'), country} - {None}
            related, residents = [], []
            for owner in [town, *town.get('residents', [])]:
                owner_files = [(entry['repoId'], entry['file']) for entry in owner_evidence(owner)]
                if owner is town:
                    owner_files += [(entry['repoId'], entry['key']) for entry in town.get('screens', [])
                                    if not entry['key'].startswith('/')]
                matches = [change for key in owner_files for change in by_file.get(key, [])]
                if owner is town:
                    matches += [change for entry in town.get('endpoints', []) for change in
                                endpoint_changes.get((entry['repoId'], entry['part'], entry['key']), [])]
                if matches and owner is not town and isinstance(owner.get('name'), str):
                    residents.append(owner['name'])
                for match in matches:
                    if match not in related:
                        related.append(match)
                    for file in {match['path'], match.get('oldPath', match['path'])}:
                        references.setdefault((match['repoId'], file), set()).add(town['id'])
                for evidence in owner_evidence(owner):
                    replacement = renames.get((evidence['repoId'], evidence['file']))
                    if replacement:
                        evidence['file'] = replacement
                        changed = True
            for screen in town.get('screens', []):
                replacement = renames.get((screen['repoId'], screen['key']))
                if replacement and not screen['key'].startswith('/'):
                    screen['key'] = replacement
                    changed = True
            if related:
                affected[town['id']] = {'id': town['id'], 'file': path.relative_to(atlas).as_posix(),
                                        'reasons': related, 'residents': sorted(set(residents))}
        if changed:
            rewrites.append((path, document, original))
    # Propagate declared dependencies to a fixed point, including city/country IDs.
    pending = True
    while pending:
        pending = False
        affected_nodes = set().union(*(hierarchy[identifier] for identifier in affected))
        for identifier, (town, city, path) in towns.items():
            dependencies = [*town.get('dependsOn', []), *city.get('dependsOn', [])]
            if identifier not in affected and any(value in affected_nodes for value in dependencies):
                affected[identifier] = {'id': identifier, 'file': path.relative_to(atlas).as_posix(),
                                        'reasons': [{'status': 'review', 'dependsOn': value}
                                                    for value in dependencies if value in affected_nodes],
                                        'residents': []}
                pending = True
    rules_report = rule_changes(atlas, state if not overrides else None, changes, documents)
    # Every source, revision and document is validated before the first rewrite.
    _recheck(config, root, atlas, roots, versions, document_fingerprint)
    if any(path.read_bytes() != original for path, _, original in documents):
        raise AtlasError('Node documents changed during diff; no source references were rewritten.')
    for (identifier, old), new in renames.items():
        if not resolve_source(roots[identifier], new).is_file():
            raise AtlasError('A renamed destination is missing; no node paths were updated.')
    for path, document, _ in rewrites:
        write_json(path, document)
    worklist = []
    for change in changes:
        files = list(dict.fromkeys([change.get('oldPath', change['path']), change['path']]))
        worklist.append({'repoId': change['repoId'], 'action': {'A': 'add', 'D': 'delete', 'R': 'rename'}.get(change['status'], 'update'),
                         'files': files, 'townIds': sorted(set().union(*(references.get((change['repoId'], file), set()) for file in files)))})
    if not rules_report['ruleIndexAvailable']:
        warnings.append('No saved rule index; source impacts require file-level review until finish records stable rules.')
    return dict(**rules_report, version=2, repositories=repositories, upToDate=not changes, changes=changes,
                affectedTowns=list(affected.values()), worklist=worklist, manualRenames=manual,
                renamedDocuments=[path.relative_to(atlas).as_posix() for path, _, _ in rewrites],
                recommendFullAnalysis=any(entry['recommendFullAnalysis'] for entry in repositories.values()), warnings=warnings)


def status_atlas(project_root, atlas_dir):
    from .validator import validate_atlas

    config, root, atlas, roots = _context(project_root, atlas_dir)
    warnings = []
    try:
        state = _state(atlas)
    except AtlasError as exc:
        state = None
        warnings.append(str(exc))
    versions = repository_versions(config, root, atlas)
    repositories = {}
    for identifier, path in roots.items():
        base = (state or {}).get('repositories', {}).get(identifier, {}).get('baseCommit')
        resolved = _resolve_commit(path, base) if base else None
        head = versions[identifier]['commit']
        dirty = _dirty_files(path, _atlas_prefix(path, atlas))
        changes = _changes(path, resolved, head, _atlas_prefix(path, atlas)) if resolved and head else []
        repositories[identifier] = dict(headCommit=head, baseCommit=base, baseValid=bool(resolved), dirtyFiles=dirty,
                                        changedFiles=len(changes), upToDate=bool(resolved and head and not changes and not dirty))
        if not resolved:
            warnings.append(f'{identifier}: no usable baseline; finish a full analysis or use --since-repo.')
    if state and set(state['repositories']) != set(roots):
        warnings.append('Configured repository IDs differ from state; reconcile the source list.')
    progress_summary = None
    try:
        progress = _progress(atlas)
        if progress is not None:
            progress_summary = dict(mode=progress['mode'], repositories=progress['repositories'],
                                    current=progress['repositories'] == versions, total=len(progress['countries']),
                                    done=sum(country['status'] == 'done' for country in progress['countries']),
                                    pending=[country['id'] for country in progress['countries'] if country['status'] != 'done'])
    except AtlasError as exc:
        warnings.append(str(exc))
    try:
        _require_inventory(atlas, versions)
        inventory_current = True
    except AtlasError:
        inventory_current = False
        warnings.append('Inventory freshness could not be verified; run scan before finish.')
    report = validate_atlas(root, atlas)
    return dict(version=2, repositories=repositories,
                upToDate=bool(state and set(state['repositories']) == set(roots)
                              and all(entry['upToDate'] for entry in repositories.values())),
                changedFiles=sum(entry['changedFiles'] for entry in repositories.values()),
                inventoryCurrent=inventory_current, coverage=report['coverage'], valid=report['valid'],
                errors=report['errors'], progress=progress_summary, warnings=[*warnings, *report['warnings']])
