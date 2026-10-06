"""Explicit, bounded source repositories for a shared analysis workspace."""
from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import re

from .common import AtlasError, _git, git_commit, resolve_source


REPOSITORY_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]*$')
RESERVED_IDS = {'__proto__', 'prototype', 'constructor'}


def git_root(path: Path) -> Path | None:
    try:
        return Path(_git(path, ['rev-parse', '--show-toplevel']).strip()).resolve()
    except AtlasError:
        return None


def parse_assignments(values: list[str] | None, option: str) -> dict[str, str]:
    result = {}
    for value in values or []:
        if not isinstance(value, str) or '=' not in value:
            raise AtlasError(f'{option} requires ID=value.')
        key, target = value.split('=', 1)
        if not REPOSITORY_ID.fullmatch(key) or key in RESERVED_IDS or not target.strip():
            raise AtlasError(f'{option} requires a valid repository ID and nonempty value.')
        if key in result:
            raise AtlasError(f'{option} repeats repository ID: {key}.')
        result[key] = target
    return result


def repository_roots(config: dict, root: Path) -> dict[str, Path]:
    """Resolve v2 roots without allowing overlapping or escaped Git checkouts."""
    root = Path(root).resolve()
    if config.get('version') == 1:
        return {'default': root}
    entries = config.get('repositories')
    if config.get('version') != 2 or not isinstance(entries, list) or not entries:
        raise AtlasError('config version 2 requires a nonempty repositories array.')
    result = {}
    for entry in entries:
        if (not isinstance(entry, dict) or not isinstance(entry.get('id'), str)
                or not REPOSITORY_ID.fullmatch(entry['id']) or entry['id'] in RESERVED_IDS):
            raise AtlasError('Repository IDs must use letters, digits, underscores or hyphens.')
        identifier = entry['id']
        if identifier in result:
            raise AtlasError('Duplicate repository ID: ' + identifier)
        if 'name' in entry and (not isinstance(entry['name'], str) or not entry['name'].strip()):
            raise AtlasError('Repository name must be a nonempty string.')
        path = resolve_source(root, entry.get('path'))
        if not path.is_dir() or git_root(path) != path:
            raise AtlasError(f'Repository {identifier} must point to an existing Git checkout root.')
        if any(path.is_relative_to(other) or other.is_relative_to(path) for other in result.values()):
            raise AtlasError('Repository paths must be distinct and must not overlap or nest.')
        result[identifier] = path
    return result


def repository_config(config: dict, repo_id: str) -> dict:
    """A v1-shaped local scan config whose fingerprint includes workspace mapping."""
    result = deepcopy(config)
    result['version'] = 1
    result.pop('repositories', None)
    result['parts'] = [{key: value for key, value in part.items() if key != 'repoId'}
                       for part in config['parts'] if part.get('repoId') == repo_id]
    result['_repositorySettings'] = {'repoId': repo_id, 'repositories': deepcopy(config['repositories'])}
    return result


def repository_versions(config: dict, root: Path, atlas_dir: Path) -> dict:
    from .updater import source_snapshot

    return {identifier: {'commit': git_commit(path),
                         'sourceSnapshot': source_snapshot(path, atlas_dir, repository_config(config, identifier))}
            for identifier, path in repository_roots(config, root).items()}


def discover_repositories(root: Path, explicit: list[str] | None = None) -> list[dict] | None:
    """Preserve a single checkout by default; only discover direct child roots."""
    root = Path(root).resolve()
    if explicit:
        entries = [{'id': key, 'path': value} for key, value in parse_assignments(explicit, '--repository').items()]
        repository_roots({'version': 2, 'repositories': entries}, root)
        return entries
    enclosing = git_root(root)
    if enclosing == root:
        return None
    entries = []
    for child in sorted(root.iterdir()):
        if not child.is_dir() or git_root(child) != child.resolve():
            continue
        if not REPOSITORY_ID.fullmatch(child.name):
            raise AtlasError(f'Use --repository ID={child.name} to assign this checkout a portable ID.')
        entries.append({'id': child.name, 'path': child.name})
    if not entries:
        if enclosing is not None:
            # Preserve v1 analysis of a subdirectory when there are no independent
            # child checkouts; an enclosing unrelated Git must not hide children.
            return None
        raise AtlasError('No Git checkouts found. Put repositories directly under project-root or use --repository ID=path.')
    repository_roots({'version': 2, 'repositories': entries}, root)
    return entries
