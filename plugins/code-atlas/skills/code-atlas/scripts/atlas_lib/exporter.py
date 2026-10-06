"""Portable JSON-only map packages; never ship source code or configuration."""
from __future__ import annotations

import io
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
from uuid import uuid4
import zipfile

from .builder import assemble_atlas
from .common import AtlasError, output_path, read_json
from .updater import verify_finished_atlas

MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
MAX_ENTRIES = 512


def _json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n').encode('utf-8')


def _filename(project_name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '-', project_name).strip(' .')[:120] or 'atlas'
    if re.fullmatch(r'(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])', name.split('.')[0]):
        name = 'atlas-' + name
    return name + '.atlas.zip'


def export_atlas(project_root: Path, atlas_dir: Path, output: Path | None = None) -> dict:
    """Export only the reviewed finished snapshot; preserve existing files on error."""
    root, atlas = Path(project_root).resolve(), Path(atlas_dir).resolve()
    verified = verify_finished_atlas(root, atlas)
    multi = isinstance(verified[0], dict)
    metadata, countries = assemble_atlas(root, atlas, **({'source_repositories': verified[0]} if multi else {'source_commit': verified[0]}))
    if not any(city['towns'] for country in countries if country['id'] != 'uncharted' for city in country['cities']):
        raise AtlasError('Export requires nonempty authored towns; complete the analysis documents first.')
    destination = output_path(output if output is not None else atlas / _filename(metadata['projectName']))
    if destination.suffix.lower() != '.zip':
        raise AtlasError('Export output must use the .zip extension.')
    if multi:
        from .repositories import repository_roots
        roots = repository_roots(read_json(atlas / 'config.json'), root)
        if any(destination.is_relative_to(source_root) for source_root in roots.values()):
            raise AtlasError('Export output cannot be inside any source repository, including a misplaced atlas-dir.')
    if destination.is_relative_to(root) and not destination.is_relative_to(atlas):
        raise AtlasError('Export output cannot overwrite/add source files; use atlas-dir or an external directory.')
    if any(destination.is_relative_to(atlas / name) for name in ('nodes', '.backups')):
        raise AtlasError('Export output must not be inside authored documents or their backups.')
    if destination.exists() and not destination.is_file():
        raise AtlasError('Export output already exists and is not a file.')
    entries = {'index.json': _json_bytes(metadata)}
    for country in countries:
        entries[f"countries/{country['id']}.json"] = _json_bytes(country)
    source_metadata = {'repositories': metadata['repositories']} if multi else {'sourceCommit': metadata['sourceCommit']}
    manifest = {'format': 'code-atlas', 'version': metadata['version'], 'projectName': metadata['projectName'],
                **source_metadata, 'generatedAt': metadata['generatedAt'],
                'files': list(entries)}
    entries = {'manifest.json': _json_bytes(manifest), **entries}
    if len(entries) > MAX_ENTRIES or sum(map(len, entries.values())) > MAX_ARCHIVE_BYTES:
        raise AtlasError('Map exceeds package limits (32 MiB / 512 entries).')
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_STORED, allowZip64=False) as package:
        for name, payload in entries.items():
            package.writestr(name, payload)
    payload = archive.getvalue()
    if len(payload) > MAX_ARCHIVE_BYTES:
        raise AtlasError('Map exceeds the 32 MiB package size limit.')
    if verify_finished_atlas(root, atlas) != verified:
        raise AtlasError('Analysis changed while exporting; rerun finish before export.')
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    backup = None
    try:
        with tempfile.NamedTemporaryFile(mode='wb', dir=destination.parent, prefix='.atlas-export-', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(payload)
        if destination.exists():
            backup = destination.with_name(destination.name + '.backup-' + uuid4().hex)
            shutil.copy2(destination, backup)
        os.replace(temporary, destination)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
    return {'archivePath': str(destination), 'projectName': metadata['projectName'],
            **source_metadata, 'countries': len(countries),
            'cities': sum(len(country['cities']) for country in countries),
            'towns': sum(len(city['towns']) for country in countries for city in country['cities']),
            'coverage': metadata['coverage'], 'backupPath': str(backup) if backup else None}
