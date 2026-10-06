"""Git change worklists and guarded advancement of the analyzed commit."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess

from .common import AtlasError, git_files, load_context, read_json, resolve_source, utc_now, write_json
from .rule_model import rule_owners, owner_evidence, rule_index, rule_changes, require_review


def _git(root: Path, *arguments: str, optional: bool = False) -> str | None:
    try:
        result = subprocess.run(['git', '-C', str(root), *arguments], capture_output=True,
                                encoding='utf-8', errors='strict', check=False)
    except (OSError, UnicodeError) as exc:
        raise AtlasError('Cannot read Git project; verify Git is installed and paths use UTF-8.') from exc
    if result.returncode:
        if optional:
            return None
        raise AtlasError('Git operation failed; verify project-root is inside a readable Git repository.')
    return result.stdout


def _resolve_commit(root: Path, revision: str) -> str | None:
    value = _git(root, 'rev-parse', '--verify', '--end-of-options', revision + '^{commit}', optional=True)
    return value.strip() if value else None


def _atlas_prefix(root: Path, atlas: Path) -> str | None:
    if root.is_relative_to(atlas):
        raise AtlasError('atlas-dir must be a dedicated directory, not project-root or its ancestor.')
    return atlas.relative_to(root).as_posix() if atlas.is_relative_to(root) else None


def _generated(path: str, prefix: str | None) -> bool:
    return prefix is not None and (path == prefix or path.startswith(prefix + '/'))


def _context(project_root: Path, atlas_dir: Path):
    from .scanner import _validate_config

    atlas = Path(atlas_dir).resolve()
    config, root = load_context(atlas, project_root)
    _validate_config(config, root)
    prefix = _atlas_prefix(root, atlas)
    _git(root, 'rev-parse', '--git-dir')
    return config, root, atlas, prefix


def source_snapshot(project_root: Path, atlas_dir: Path, config: dict) -> str:
    """Fingerprint scan settings and tracked part files, without storing source text.

    Include manifests and evidence-only files as well as parsed extensions. The
    scanner records this before/after reading sources; finish checks it again.
    """
    from .scanner import DEFAULT_EXCLUDE, _validate_config, excluded

    root, atlas = Path(project_root).resolve(), Path(atlas_dir).resolve()
    _validate_config(config, root)
    prefix = _atlas_prefix(root, atlas)
    digest = hashlib.sha256()
    settings = {'parts': config['parts'], 'exclude': config.get('exclude', DEFAULT_EXCLUDE)}
    if '_repositorySettings' in config:
        settings['repositories'] = config['_repositorySettings']
    digest.update(json.dumps(settings, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8'))
    for file in git_files(root):
        if _generated(file, prefix) or excluded(file, settings['exclude']):
            continue
        path = resolve_source(root, file)
        digest.update(b'\0path\0' + file.encode('utf-8') + b'\0')
        if path.is_file():
            digest.update(hashlib.sha256(path.read_bytes()).digest())
        else:
            digest.update(b'missing-or-directory')
    return digest.hexdigest()


def _dirty_files(root: Path, prefix: str | None) -> list[str]:
    # Porcelain v1 -z paths are repository-relative even when -C is a subdirectory.
    repository = Path(_git(root, 'rev-parse', '--show-toplevel').strip()).resolve()
    project_prefix = root.relative_to(repository).as_posix()
    project_prefix = '' if project_prefix == '.' else project_prefix + '/'
    fields = _git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.').split('\0')
    result, index = set(), 0
    while index < len(fields):
        row = fields[index]
        index += 1
        if not row:
            continue
        status, paths = row[:2], [row[3:]]
        if any(code in status for code in ('R', 'C')) and index < len(fields):
            paths.append(fields[index])
            index += 1
        for path in paths:
            if project_prefix and not path.startswith(project_prefix):
                continue
            path = path[len(project_prefix):]
            if path and not _generated(path, prefix):
                result.add(path)
    return sorted(result)


def _require_clean(root: Path, prefix: str | None) -> None:
    dirty = _dirty_files(root, prefix)
    if dirty:
        raise AtlasError(f'{len(dirty)} uncommitted source/project file(s); commit or restore them before diff/finish. Atlas documents are ignored.')


def _state(atlas: Path) -> dict | None:
    path = atlas / 'state.json'
    if not path.exists():
        return None
    state = read_json(path)
    if (not isinstance(state, dict) or state.get('version') != 1
            or not isinstance(state.get('baseCommit'), str) or not state['baseCommit'].strip()):
        raise AtlasError('Invalid state.json; use diff --since <commit> or perform a full analysis and finish.')
    return state


def _progress(atlas: Path) -> dict | None:
    path = atlas / 'progress.json'
    if not path.exists():
        return None
    progress = read_json(path)
    if (not isinstance(progress, dict) or progress.get('mode') not in ('init', 'update')
            or not isinstance(progress.get('sourceCommit'), str)
            or not isinstance(progress.get('countries'), list)):
        raise AtlasError('progress.json requires mode, sourceCommit, and a countries array.')
    seen = set()
    for country in progress['countries']:
        if (not isinstance(country, dict) or not isinstance(country.get('id'), str) or not country['id']
                or country.get('status') not in ('pending', 'in-progress', 'done') or country['id'] in seen):
            raise AtlasError('progress.json countries require unique IDs and pending/in-progress/done status.')
        seen.add(country['id'])
    return progress


def document_snapshot(atlas: Path) -> str:
    """Fingerprint the actual reviewed inputs, excluding generated outputs/backups."""
    atlas = Path(atlas).resolve()
    paths = [atlas / name for name in ('config.json', 'inventory.json', 'overrides.json', 'progress.json', 'rule-review.json')]
    paths.extend(sorted((atlas / 'nodes').glob('*/*.json')))
    digest = hashlib.sha256()
    for path in paths:
        if not path.resolve().is_relative_to(atlas):
            raise AtlasError('Analysis document escapes atlas-dir.')
        digest.update(path.relative_to(atlas).as_posix().encode('utf-8') + b'\0')
        digest.update(hashlib.sha256(path.read_bytes()).digest() if path.exists() else b'missing')
    return digest.hexdigest()


def verify_finished_atlas(project_root: Path, atlas_dir: Path) -> tuple[str, str]:
    """Read-only gate for publishing the exact analysis accepted by finish."""
    if load_context(atlas_dir, project_root)[0].get('version') == 2:
        from .updater_multi import verify_finished_atlas as multi_verify_finished_atlas
        return multi_verify_finished_atlas(project_root, atlas_dir)
    config, root, atlas, prefix = _context(project_root, atlas_dir)
    head = _resolve_commit(root, 'HEAD')
    state = _state(atlas)
    if not head or not state or state.get('baseCommit') != head:
        raise AtlasError('Export requires finish at the current HEAD; run scan, review, and finish first.')
    _require_clean(root, prefix)
    inventory = read_json(atlas / 'inventory.json')
    if (not isinstance(inventory, dict) or inventory.get('commit') != head
            or inventory.get('sourceSnapshot') != source_snapshot(root, atlas, config)):
        raise AtlasError('Inventory/source/settings are stale; run scan, review, and finish before export.')
    progress = _progress(atlas)
    if progress is not None and (progress['sourceCommit'] != head
                                or any(country['status'] != 'done' for country in progress['countries'])):
        raise AtlasError('Analysis progress is incomplete or refers to another source version.')
    snapshot = document_snapshot(atlas)
    if state.get('documentsSnapshot') != snapshot:
        raise AtlasError('Analysis documents changed or were not fingerprinted; validate and run finish before export.')
    return head, snapshot


def finish_atlas(project_root: Path, atlas_dir: Path) -> dict:
    """Advance state only after the current HEAD and its analysis are verified."""
    from .validator import validate_atlas

    if load_context(atlas_dir, project_root)[0].get('version') == 2:
        from .updater_multi import finish_atlas as multi_finish_atlas
        return multi_finish_atlas(project_root, atlas_dir)
    config, root, atlas, prefix = _context(project_root, atlas_dir)
    head = _resolve_commit(root, 'HEAD')
    if not head:
        raise AtlasError('finish requires an existing Git HEAD; commit the source project first.')
    _require_clean(root, prefix)
    inventory = read_json(atlas / 'inventory.json')
    if not isinstance(inventory, dict) or inventory.get('commit') != head:
        raise AtlasError('Inventory does not correspond to HEAD; run scan and review the documents before finish.')
    snapshot = source_snapshot(root, atlas, config)
    if inventory.get('sourceSnapshot') != snapshot:
        raise AtlasError('Source/settings snapshot is missing or changed; run scan and review the documents before finish.')
    progress = _progress(atlas)
    if progress is not None:
        if progress['sourceCommit'] != head:
            raise AtlasError('progress.json sourceCommit differs from HEAD; reconcile the analysis before finish.')
        if any(country['status'] != 'done' for country in progress['countries']):
            raise AtlasError('Analysis progress is incomplete; finish all countries before advancing the baseline.')
    documents = document_snapshot(atlas)
    report = validate_atlas(root, atlas)
    if not report['valid']:
        raise AtlasError('Validation failed; run validate and resolve its errors before finish. The baseline was not changed.')
    require_review(report)
    rules_snapshot = rule_index(atlas)
    # Catch source/config/HEAD changes that occur while validating evidence.
    _require_clean(root, prefix)
    current_config, _ = load_context(atlas, root)
    if _resolve_commit(root, 'HEAD') != head or source_snapshot(root, atlas, current_config) != snapshot:
        raise AtlasError('HEAD or source/settings changed during finish; rerun scan and validation.')
    if document_snapshot(atlas) != documents:
        raise AtlasError('Analysis documents changed during finish; rerun validation and finish.')
    branch = _git(root, 'symbolic-ref', '--short', '-q', 'HEAD', optional=True)
    state = {'version': 1, 'baseCommit': head, 'branch': branch.strip() if branch else '(detached)',
             'analyzedAt': utc_now(), 'documentsSnapshot': documents, 'ruleIndex': rules_snapshot}
    write_json(atlas / 'state.json', state)
    return {'state': state, 'coverage': report['coverage'], 'uncharted': report['uncharted'], 'warnings': report['warnings'], 'businessReview': report['businessReview']}


def _changes(root: Path, base: str, head: str, prefix: str | None) -> list[dict]:
    fields = _git(root, 'diff', '--name-status', '-M', '-z', '--relative', base + '..' + head, '--', '.').split('\0')
    changes, index = [], 0
    while index < len(fields) and fields[index]:
        status = fields[index]
        index += 1
        count = 2 if status.startswith(('R', 'C')) else 1
        if index + count > len(fields) or any(not p for p in fields[index:index + count]):
            raise AtlasError('Cannot parse Git change list; no node paths were updated.')
        paths = fields[index:index + count]
        index += count
        for path in paths:
            resolve_source(root, path)
        if count == 2:
            old, new = paths
            old_generated, new_generated = _generated(old, prefix), _generated(new, prefix)
            if old_generated and new_generated:
                continue
            if old_generated:
                changes.append({'status': 'A', 'path': new})
            elif new_generated:
                changes.append({'status': 'D', 'path': old})
            else:
                changes.append({'status': status[0], 'path': new, 'oldPath': old})
        elif not _generated(paths[0], prefix):
            changes.append({'status': status[0], 'path': paths[0]})
    return changes


def _documents(atlas: Path, multi: bool = False) -> list[tuple[Path, dict, bytes]]:
    nodes = atlas / 'nodes'
    if nodes.exists() and not nodes.resolve().is_relative_to(atlas):
        raise AtlasError('nodes directory escapes atlas-dir; no files were changed.')
    result = []
    for path in sorted(nodes.glob('*/*.json')):
        if not path.resolve().is_relative_to(atlas):
            raise AtlasError('Node document escapes atlas-dir; no files were changed.')
        original = path.read_bytes()
        try:
            document = json.loads(original.decode('utf-8-sig'))
        except (ValueError, UnicodeError) as exc:
            raise AtlasError('Node document is not valid UTF-8 JSON; repair it before diff.') from exc
        if not isinstance(document, dict):
            raise AtlasError('Node documents must be JSON objects; repair them before diff.')
        if path.name == '_country.json':
            continue
        towns = document.get('towns')
        if not isinstance(towns, list):
            raise AtlasError('City documents require a towns array; repair them before diff.')
        for town in towns:
            if not isinstance(town, dict) or not isinstance(town.get('id'), str):
                raise AtlasError('Each town requires an ID; repair node documents before diff.')
            residents = town.get('residents', [])
            if not isinstance(residents, list) or any(not isinstance(resident, dict) for resident in residents):
                raise AtlasError('Town residents must be objects; repair node documents before diff.')
            for owner in rule_owners(town):
                evidence = owner.get('evidence', [])
                if (not isinstance(evidence, list)
                        or any(not isinstance(entry, dict) or not isinstance(entry.get('file'), str) for entry in evidence)):
                    raise AtlasError('Evidence requires file paths; repair node documents before diff.')
            screens = town.get('screens', [])
            if not isinstance(screens, list) or any(not isinstance(screen, dict if multi else str) for screen in screens):
                raise AtlasError('Town screens must be strings; repair node documents before diff.')
        result.append((path, document, original))
    return result


def diff_atlas(project_root: Path, atlas_dir: Path, *, since: str | None = None,
               since_repositories: list[str] | None = None) -> dict:
    """Produce review work and update only exact renamed source references."""
    if load_context(atlas_dir, project_root)[0].get('version') == 2:
        from .updater_multi import diff_atlas as multi_diff
        return multi_diff(project_root, atlas_dir, since=since, since_repositories=since_repositories)
    if since_repositories:
        raise AtlasError('--since-repo requires config version 2; use --since for a single Git project.')
    _, root, atlas, prefix = _context(project_root, atlas_dir)
    head = _resolve_commit(root, 'HEAD')
    if not head:
        raise AtlasError('diff requires an existing Git HEAD; commit the source project first.')
    _require_clean(root, prefix)
    state = _state(atlas) if since is None else None
    revision = since if since is not None else (state['baseCommit'] if state else None)
    if not isinstance(revision, str) or not revision.strip():
        raise AtlasError('No analysis baseline; use diff --since <commit> or perform a full analysis and finish.')
    base = _resolve_commit(root, revision)
    if not base:
        raise AtlasError('Baseline commit is unavailable; use diff --since <commit> or perform a full analysis after rebase/squash.')
    changes = _changes(root, base, head, prefix)
    documents = _documents(atlas)
    rename_changes = [change for change in changes if change['status'] == 'R']
    old_paths = {change['oldPath'] for change in rename_changes}
    new_paths = {change['path'] for change in rename_changes}
    # A->B and B->C cannot be applied twice to documents without remembering
    # which generation each reference belongs to. Leave overlapping moves for
    # explicit review so resuming diff can never turn an already updated B into C.
    manual_renames = [change for change in rename_changes
                      if change['oldPath'] in new_paths or change['path'] in old_paths]
    renames = {change['oldPath']: change['path'] for change in rename_changes if change not in manual_renames}
    by_file = {}
    for change in changes:
        for file in {change['path'], change.get('oldPath', change['path'])}:
            by_file.setdefault(file, []).append(change)
    affected, rewrites, references = [], [], {}
    for path, document, original in documents:
        changed = False
        for town in document['towns']:
            related, resident_names = [], []
            for owner in [town, *town.get('residents', [])]:
                owner_files = [entry['file'] for entry in owner_evidence(owner)]
                if owner is town:
                    owner_files += [screen for screen in town.get('screens', []) if not screen.startswith('/')]
                matches = [change for file in owner_files for change in by_file.get(file, [])]
                if matches and owner is not town and isinstance(owner.get('name'), str):
                    resident_names.append(owner['name'])
                for match in matches:
                    if match not in related:
                        related.append(match)
                    for file in (match['path'], match.get('oldPath', match['path'])):
                        references.setdefault(file, set()).add(town['id'])
                for evidence in owner_evidence(owner):
                    if evidence['file'] in renames:
                        evidence['file'] = renames[evidence['file']]
                        changed = True
            screens = town.get('screens', [])
            for index, screen in enumerate(screens):
                if not screen.startswith('/') and screen in renames:
                    screens[index] = renames[screen]
                    changed = True
            if related:
                affected.append({'id': town['id'], 'file': path.relative_to(atlas).as_posix(),
                                 'reasons': related, 'residents': sorted(set(resident_names))})
        if changed:
            rewrites.append((path, document, original))
    rules_report = rule_changes(atlas, state, changes, documents)
    # Complete all checks before changing the first document.
    _require_clean(root, prefix)
    if _resolve_commit(root, 'HEAD') != head or any(path.read_bytes() != original for path, _, original in documents):
        raise AtlasError('Source or node documents changed during diff; rerun before updating paths.')
    for old, new in renames.items():
        if not resolve_source(root, new).is_file():
            raise AtlasError('A renamed destination is missing; no node paths were updated.')
    for path, document, _ in rewrites:
        write_json(path, document)
    worklist = []
    for change in changes:
        files = list(dict.fromkeys([change.get('oldPath', change['path']), change['path']]))
        worklist.append({'action': {'A': 'add', 'D': 'delete', 'R': 'rename'}.get(change['status'], 'update'),
                         'files': files, 'townIds': sorted(set().union(*(references.get(file, set()) for file in files)))})
    baseline_files = _git(root, 'ls-tree', '-r', '--name-only', '-z', base, '--', '.').split('\0')
    # ls-tree emits cwd-relative paths unless --full-name is requested.
    current_files = git_files(root)
    total_files = max(sum(bool(file) and not _generated(file, prefix) for file in baseline_files),
                      sum(not _generated(file, prefix) for file in current_files), 1)
    ratio = len(changes) / total_files
    warnings = ['More than 30% of tracked project files changed; consider a full analysis.'] if ratio > 0.3 else []
    if manual_renames:
        warnings.append('Overlapping rename paths require manual evidence/screens updates; diff did not automatically change those references.')
    if not rules_report['ruleIndexAvailable']:
        warnings.append('No saved rule index; source impacts require file-level review until finish records stable rules.')
    return {**rules_report, 'baseCommit': base, 'headCommit': head, 'upToDate': not changes, 'changes': changes,
            'affectedTowns': affected, 'worklist': worklist,
            'renamedDocuments': [path.relative_to(atlas).as_posix() for path, _, _ in rewrites],
            'manualRenames': manual_renames,
            'changeRatio': round(ratio, 4), 'recommendFullAnalysis': ratio > 0.3, 'warnings': warnings}


def status_atlas(project_root: Path, atlas_dir: Path) -> dict:
    """Read status and coverage without changing inventory, documents, or state."""
    from .validator import validate_atlas

    if load_context(atlas_dir, project_root)[0].get('version') == 2:
        from .updater_multi import status_atlas as multi_status_atlas
        return multi_status_atlas(project_root, atlas_dir)
    config, root, atlas, prefix = _context(project_root, atlas_dir)
    warnings = []
    head = _resolve_commit(root, 'HEAD')
    try:
        state = _state(atlas)
    except AtlasError as exc:
        state = None
        warnings.append(str(exc))
    base = state.get('baseCommit') if state else None
    resolved_base = _resolve_commit(root, base) if base else None
    if not resolved_base:
        warnings.append('No usable baseline; use diff --since <commit> or perform a full analysis and finish.')
    try:
        progress = _progress(atlas)
    except AtlasError as exc:
        progress = None
        warnings.append(str(exc))
    summary = None
    if progress is not None:
        countries = progress['countries']
        summary = {'mode': progress['mode'], 'sourceCommit': progress['sourceCommit'],
                   'total': len(countries), 'done': sum(c['status'] == 'done' for c in countries),
                   'pending': [c['id'] for c in countries if c['status'] != 'done']}
    report = validate_atlas(root, atlas)
    inventory_current = False
    try:
        inventory = read_json(atlas / 'inventory.json')
        inventory_current = (isinstance(inventory, dict) and head is not None and inventory.get('commit') == head
                             and inventory.get('sourceSnapshot') == source_snapshot(root, atlas, config))
    except (AtlasError, OSError):
        warnings.append('Inventory freshness could not be verified; run scan before finish.')
    dirty = _dirty_files(root, prefix)
    changes = _changes(root, resolved_base, head, prefix) if resolved_base and head else []
    return {'headCommit': head, 'baseCommit': base, 'baseValid': resolved_base is not None,
            'upToDate': bool(resolved_base and head and not changes and not dirty),
            'dirtyFiles': dirty, 'changedFiles': len(changes), 'inventoryCurrent': inventory_current,
            'coverage': report['coverage'], 'valid': report['valid'], 'errors': report['errors'],
            'progress': summary, 'warnings': [*warnings, *report['warnings']]}
