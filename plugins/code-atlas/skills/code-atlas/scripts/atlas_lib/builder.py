"""Build an offline, country-chunked atlas without changing authored nodes."""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile
from uuid import uuid4

from .common import AtlasError, output_path, read_json, utc_now
from .evidence import find_symbol_line
from .rule_model import rule_owners
from .validator import validate_atlas


def _javascript(value: object) -> str:
    # Data is executable only as a JSON literal; protect script delimiters too.
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace(
        "<", "\\u003c"
    ).replace(">", "\\u003e").replace("&", "\\u0026").replace(
        "\u2028", "\\u2028"
    ).replace("\u2029", "\\u2029")


def _read_countries(atlas: Path) -> list[dict]:
    countries = []
    for path in sorted((atlas / "nodes").glob("*/_country.json")):
        country = copy.deepcopy(read_json(path))
        country["level"] = "country"
        country["cities"] = [copy.deepcopy(read_json(path.parent / (node_id.rsplit(".", 1)[-1] + ".json")))
                             for node_id in country["cities"]]
        for city in country["cities"]:
            city["level"] = "city"
            for town in city["towns"]:
                town["level"] = "town"
        countries.append(country)
    return countries


def _apply_overrides(countries: list[dict], overrides: dict) -> list[dict]:
    nodes = {}
    parents = {}
    for country in countries:
        nodes[country["id"]] = country
        for city in country["cities"]:
            nodes[city["id"]] = city
            for town in city["towns"]:
                nodes[town["id"]] = town
                parents[town["id"]] = city
    if not isinstance(overrides, dict):
        raise AtlasError("overrides.json 必須是物件")
    unknown = set(overrides) - {"rename", "summary", "move", "hide"}
    if unknown:
        raise AtlasError("overrides.json 不支援的欄位：" + ", ".join(sorted(unknown)))
    for field in ("rename", "summary", "move"):
        if not isinstance(overrides.get(field, {}), dict):
            raise AtlasError(f"overrides.{field} 必須是物件")
        for node_id, value in overrides.get(field, {}).items():
            if node_id not in nodes:
                raise AtlasError(f"overrides.{field} 指向不存在的節點：{node_id}")
            if not isinstance(value, str) or not value.strip():
                raise AtlasError(f"overrides.{field}.{node_id} 必須是非空字串")
            if field == "move":
                if nodes[node_id]["level"] != "town":
                    raise AtlasError(f"overrides.move 只能搬移鄉鎮：{node_id}")
                if value not in nodes or nodes[value]["level"] != "city":
                    raise AtlasError(f"overrides.move 目的城市不存在：{value}")
    hidden = overrides.get("hide", [])
    if not isinstance(hidden, list) or any(not isinstance(value, str) for value in hidden):
        raise AtlasError("overrides.hide 必須是節點 ID 陣列")
    for node_id in hidden:
        if node_id not in nodes:
            raise AtlasError(f"overrides.hide 指向不存在的節點：{node_id}")
    for field, target in (("rename", "name"), ("summary", "summary")):
        for node_id, value in overrides.get(field, {}).items():
            nodes[node_id][target] = value
    for node_id, city_id in overrides.get("move", {}).items():
        town = nodes[node_id]
        parents[node_id]["towns"].remove(town)
        nodes[city_id]["towns"].append(town)
    visible = []
    for country in countries:
        if country["id"] in hidden:
            continue
        country["cities"] = [city for city in country["cities"] if city["id"] not in hidden]
        for city in country["cities"]:
            city["towns"] = [town for town in city["towns"] if town["id"] not in hidden]
        visible.append(country)
    return visible


def _locate_evidence(root: Path, node: dict, cache: dict, roots: dict[str, Path] | None = None) -> None:
    for evidence in node.get("evidence", []):
        source_root = roots[evidence['repoId']] if roots is not None else root
        source = (source_root / evidence["file"]).resolve()
        if not source.is_relative_to(source_root) or not source.is_file():
            raise AtlasError(f"程式位置不在專案內或不存在：{evidence['file']}")
        key = (source, evidence.get("symbol"))
        if key not in cache:
            cache[key] = find_symbol_line(source, evidence.get("symbol"))
        line = cache[key]
        if line is None:
            raise AtlasError(f"找不到程式符號：{evidence['file']} {evidence.get('symbol', '')}")
        evidence.pop("line", None)
    for rule in node.get("rules", []):
        if isinstance(rule, dict):
            _locate_evidence(root, rule, cache, roots)
    for resident in node.get("residents", []):
        _locate_evidence(root, resident, cache, roots)


def _uncharted_country(items: list[dict]) -> dict:
    country = {"id": "uncharted", "name": "未開發地區", "level": "country",
               "summary": "已盤點、尚未歸入鄉鎮的 API 與畫面。補上對應文件後重新建置，即可更新覆蓋率。", "cities": []}
    for kind, name in (("endpoint", "API 入口"), ("route", "畫面路由"), ("page", "頁面元件")):
        selected = [item for item in items if item.get("kind") == kind]
        if not selected:
            continue
        city = {"id": f"uncharted.{kind}", "name": name, "level": "city",
                "summary": "這些項目還沒有對應的功能說明。", "towns": []}
        for index, item in enumerate(selected):
            evidence = {key: item[key] for key in ("repoId", "file", "symbol") if key in item}
            evidence["role"] = "api" if kind == "endpoint" else "screen"
            ref = {key: item[key] for key in ('repoId', 'part', 'key')} if 'repoId' in item else item['key']
            town = {"id": f"uncharted.{kind}.item-{index + 1}", "name": item["key"],
                    "level": "town", "type": "uncovered", "summary": "尚未歸類；請在文件中記錄它所屬的功能。",
                    "evidence": [evidence], "endpoints" if kind == "endpoint" else "screens": [ref]}
            city["towns"].append(town)
        country["cities"].append(city)
    return country


def assemble_atlas(project_root: Path, atlas_dir: Path, *, source_commit: str | None = None,
                   source_repositories: dict | None = None) -> tuple[dict, list[dict]]:
    """Shared validated data model for both the built viewer and portable ZIP."""
    root, atlas = Path(project_root).resolve(), Path(atlas_dir).resolve()
    report = validate_atlas(root, atlas)
    if not report.get("valid"):
        raise AtlasError("文件驗證失敗，無法建置：\n" + "\n".join(report.get("errors", [])))
    config = read_json(atlas / "config.json")
    multi = config.get('version') == 2
    roots = None
    if multi:
        from .repositories import repository_roots
        roots = repository_roots(config, root)
    countries = _read_countries(atlas)
    override_path = atlas / "overrides.json"
    overrides = read_json(override_path) if override_path.exists() else {}
    countries = _apply_overrides(countries, overrides)
    # Hidden nodes must not survive as dependency targets in the generated screens.
    visible = {node["id"] for country in countries
               for node in [country, *country["cities"], *(town for city in country["cities"] for town in city["towns"])]}
    visible_rules = {rule['id'] for country in countries for city in country['cities'] for town in city['towns']
                     for owner in rule_owners(town) for rule in owner.get('rules', []) if isinstance(rule, dict)}
    for country in countries:
        for node in [*country["cities"], *(town for city in country["cities"] for town in city["towns"])]:
            if "dependsOn" in node:
                node["dependsOn"] = [target for target in node["dependsOn"] if target in visible]
            if node.get('level') == 'town':
                for owner in rule_owners(node):
                    for rule in owner.get('rules', []):
                        if isinstance(rule, dict) and 'dependsOn' in rule:
                            rule['dependsOn'] = [target for target in rule['dependsOn'] if target in visible_rules]
    line_cache = {}
    for country in countries:
        for city in country["cities"]:
            for town in city["towns"]:
                _locate_evidence(root, town, line_cache, roots)
    if report.get("uncharted"):
        countries.append(_uncharted_country(report["uncharted"]))
    generated_at = utc_now()
    inventory = read_json(atlas / "inventory.json")
    metadata = {"version": 2 if multi else 1, "projectName": config.get("projectName", root.name), "generatedAt": generated_at,
                "coverage": report["coverage"], "businessReview": report["businessReview"], "warnings": report.get("warnings", []),
                "parts": [{key: part[key] for key in (('repoId', 'name', 'kind') if multi else ('name', 'kind'))} for part in config["parts"]],
                "hiddenCount": len(overrides.get("hide", [])), "countries": []}
    if multi:
        versions = source_repositories if source_repositories is not None else inventory['repositories']
        if set(versions) != set(roots):
            raise AtlasError('Repository versions must match every configured source.')
        metadata['repositories'] = [{'id': repo['id'], 'name': repo.get('name', repo['id']),
                                     'commit': versions[repo['id']]['commit']} for repo in config['repositories']]
        metadata['coverageByRepository'] = report['coverageByRepository']
    else:
        metadata['sourceCommit'] = source_commit if source_commit is not None else inventory.get('commit')
    for country in countries:
        # Optional fields are copied only when present so the overview stays small.
        cities = [{key: city[key] for key in ("id", "name", "summary", "level")}
                  | {key: city[key] for key in ("dependsOn",) if city.get(key)}
                  | {"townCount": len(city["towns"])} for city in country["cities"]]
        metadata["countries"].append(
            {key: country[key] for key in ("id", "name", "summary", "level")}
            | {key: country[key] for key in ("actors",) if country.get(key)}
            | {"cities": cities, "townCount": sum(city["townCount"] for city in cities),
               "chunk": f"countries/{country['id']}.json"})
    return metadata, countries


def _write_viewer(destination: Path, metadata: dict, countries: list[dict], *, built_in: bool) -> dict:
    """Stage a complete static site before replacing a known output directory."""
    viewer = Path(__file__).resolve().parents[2] / "viewer"
    if not (viewer / "vendor" / "d3.v7.min.js").is_file():
        raise AtlasError("缺少本地 D3：請還原 viewer/vendor/d3.v7.min.js")
    build = output_path(destination)
    if build.exists() and not build.is_dir():
        raise AtlasError("build 已存在且不是目錄")
    parent = build.parent.resolve()
    parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".build-", dir=parent)).resolve()
    backup = None
    try:
        for name in ("app.js", "style.css", "globe.html", "globe.js", "globe.css",
                     "atlas-package.js", "atlas-library.js", "atlas-library.css"):
            shutil.copy2(viewer / name, stage / name)
        # Read templates without preserving their old HTTP Last-Modified time.
        html_sources = {'index.html': 'globe.html', 'globe.html': 'globe.html', 'classic.html': 'index.html'}
        shutil.copytree(viewer / "vendor", stage / "vendor")
        chunks = stage / "data" / "chunks"
        chunks.mkdir(parents=True)
        (stage / ".code-atlas-viewer").write_text("code-atlas-viewer-v1\n", encoding="utf-8")
        for country in countries:
            (chunks / (country["id"] + ".js")).write_text(
                "window.ATLAS_CHUNKS=window.ATLAS_CHUNKS||{};window.ATLAS_CHUNKS["
                + _javascript(country["id"]) + "]=" + _javascript(country) + ";\n", encoding="utf-8")
        def versioned(relative: str) -> str:
            digest = hashlib.sha256((stage / relative).read_bytes()).hexdigest()[:16]
            return relative + '?v=' + digest

        screen_index = copy.deepcopy(metadata)
        screen_index['builtIn'] = built_in
        for country in screen_index['countries']:
            country['chunk'] = versioned(f"data/chunks/{country['id']}.js")
        (stage / "data" / "index.js").write_text("window.ATLAS_INDEX=" + _javascript(screen_index) + ";\n", encoding="utf-8")
        # Mutable first-party files get content addresses; bundled vendor URLs stay stable.
        def asset_reference(match):
            relative = match.group(2)
            if relative.startswith('vendor/') or not (stage / relative).is_file():
                return match.group(0)
            return match.group(1) + versioned(relative) + match.group(3)

        for name, template in html_sources.items():
            html = (viewer / template).read_text(encoding='utf-8')
            html = re.sub(r'((?:src|href)=")([^"?]+\.(?:js|css))(\")', asset_reference, html)
            (stage / name).write_text(html, encoding='utf-8')
        # All recursive cleanup and rename targets are verified direct children.
        if stage.parent != parent:
            raise AtlasError("暫存建置路徑不在輸出父目錄內")
        if build.exists():
            backup = parent / (build.name + ".backup-" + uuid4().hex)
            build.rename(backup)
        try:
            stage.rename(build)
        except OSError:
            if backup is not None and not build.exists():
                backup.rename(build)
            raise
    finally:
        if stage.exists() and stage.parent == parent and not stage.is_symlink():
            shutil.rmtree(stage)
    return {"indexPath": str(build / "index.html"), "globePath": str(build / "globe.html"),
            "classicPath": str(build / "classic.html"),
            "countries": len(countries),
            "cities": sum(len(country["cities"]) for country in countries),
            "towns": sum(len(city["towns"]) for country in countries for city in country["cities"]),
            "coverage": metadata["coverage"], "backupPath": str(backup) if backup else None}


def build_atlas(project_root: Path, atlas_dir: Path) -> dict:
    """Validate and generate a self-contained viewer; archive the previous build."""
    atlas = Path(atlas_dir).resolve()
    metadata, countries = assemble_atlas(project_root, atlas)
    if metadata['version'] == 2:
        from .repositories import repository_roots
        roots = repository_roots(read_json(atlas / 'config.json'), Path(project_root).resolve())
        if any((atlas / 'build').is_relative_to(source_root) for source_root in roots.values()):
            raise AtlasError('Build output must not be inside any source repository; place atlas-dir in the workspace.')
    return _write_viewer(atlas / "build", metadata, countries, built_in=True)


def build_viewer(output: Path) -> dict:
    """Create an import-only site without a project/config or bundled analysis."""
    destination = output_path(output)
    if destination == destination.parent:
        raise AtlasError("viewer 輸出必須是獨立資料夾，不能是根目錄或連結")
    if destination.exists():
        if not destination.is_dir():
            raise AtlasError("viewer 輸出已存在且不是資料夾")
        marker = destination / ".code-atlas-viewer"
        if any(destination.iterdir()) and (not marker.is_file() or marker.read_text(encoding='utf-8') != 'code-atlas-viewer-v1\n'):
            raise AtlasError("viewer 不能覆蓋既有來源或文件目錄；請指定新的獨立資料夾")
        if any((destination / name).exists() for name in ('.git', 'config.json', 'nodes', 'atlas.py')):
            raise AtlasError("viewer 不能覆蓋來源或 atlas 文件目錄")
    metadata = {'version': 1, 'projectName': 'Code Atlas', 'generatedAt': utc_now(), 'sourceCommit': None,
                'coverage': {'total': 0, 'covered': 0, 'percent': 100}, 'warnings': [], 'parts': [],
                'hiddenCount': 0, 'countries': []}
    return _write_viewer(destination, metadata, [], built_in=False)
