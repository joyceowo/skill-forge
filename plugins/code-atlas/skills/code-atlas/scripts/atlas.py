#!/usr/bin/env python3
"""Code Atlas command line entry point (Python 3.10+, no packages required)."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from atlas_lib.common import AtlasError, load_context


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Code Atlas：盤點程式、驗證文件、建立三層縮放畫面")
    commands = parser.add_subparsers(dest="command", required=True)
    for name, help_text in (("init", "偵測專案並建立設定"), ("scan", "盤點路由、API、頁面與商業規則候選及解析狀態"),
                            ("validate", "檢查文件與程式證據"), ("build", "建立可離線開啟的 HTML 畫面"),
                            ("diff", "比對 Git 基準並列出待更新文件"), ("finish", "驗證後記錄完成的程式版本"),
                            ("status", "查看地圖進度、覆蓋率與版本差異"),
                            ("export", "將已完成分析匯出為可匯入的地圖 ZIP")):
        command = commands.add_parser(name, help=help_text)
        command.add_argument("--project-root", type=Path, help="程式專案位置；預設讀取 config.json")
        command.add_argument("--atlas-dir", type=Path, help="文件目錄；預設為 project-root/.atlas")
        if name == "init":
            command.add_argument("--repository", action="append", help="Include a Git checkout: ID=relative/path (repeatable)")
        if name == "diff":
            command.add_argument("--since", help="明確指定此次比較的 Git 基準，不會直接更新 state")
            command.add_argument("--since-repo", action="append", help="Override one source baseline: ID=SHA (repeatable)")
        if name == "export":
            command.add_argument("--output", type=Path, help="ZIP 位置；預設 atlas-dir/專案名.atlas.zip")
    viewer = commands.add_parser("viewer", help="建立可匯入地圖 ZIP 的獨立網站，不需要原始專案")
    viewer.add_argument("--output", type=Path, required=True, help="網站專用輸出資料夾")
    args = parser.parse_args(argv)
    explicit_root = args.project_root.resolve() if getattr(args, 'project_root', None) else None
    atlas_dir = (getattr(args, 'atlas_dir', None) or (explicit_root or Path.cwd()) / ".atlas").resolve()
    try:
        if args.command == "viewer":
            from atlas_lib.builder import build_viewer
            result = build_viewer(args.output)
        elif args.command == "init":
            from atlas_lib.scanner import init_project
            result = init_project(explicit_root or Path.cwd(), atlas_dir, repositories=args.repository)
        else:
            _, project_root = load_context(atlas_dir, explicit_root)
            if args.command == "scan":
                from atlas_lib.scanner import scan_project
                result = scan_project(project_root, atlas_dir)
            elif args.command == "validate":
                from atlas_lib.validator import validate_atlas
                result = validate_atlas(project_root, atlas_dir)
            elif args.command == "build":
                from atlas_lib.builder import build_atlas
                result = build_atlas(project_root, atlas_dir)
            elif args.command == "export":
                from atlas_lib.exporter import export_atlas
                result = export_atlas(project_root, atlas_dir, args.output)
            elif args.command == "diff":
                from atlas_lib.updater import diff_atlas
                result = diff_atlas(project_root, atlas_dir, since=args.since, since_repositories=args.since_repo)
            elif args.command == "finish":
                from atlas_lib.updater import finish_atlas
                result = finish_atlas(project_root, atlas_dir)
            else:
                from atlas_lib.updater import status_atlas
                result = status_atlas(project_root, atlas_dir)
        print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
        return 1 if args.command == "validate" and not result["valid"] else 0
    except (AtlasError, OSError, UnicodeError) as exc:
        print(f"錯誤：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
