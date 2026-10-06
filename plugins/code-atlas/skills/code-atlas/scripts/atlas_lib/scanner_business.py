"""Syntax-backed review candidates, not inferred or proven business rules.

All source text stays local. Candidate identities hash concrete syntax tokens;
comments, indentation and line positions do not enter the identity. Identical
syntax in the same file/symbol/category is one candidate with occurrences.
"""
from __future__ import annotations

import ast
import hashlib
from importlib import metadata
import json
from pathlib import Path
import re

from .common import git_files, resolve_source


ENGINE_NAME = 'ast-grep-py'
ENGINE_VERSION = '0.45.3'
LANGUAGES = {'.py': 'python', '.cs': 'csharp', '.tsx': 'tsx', '.jsx': 'jsx',
             '.ts': 'typescript', '.js': 'javascript', '.mts': 'typescript',
             '.cts': 'typescript', '.mjs': 'javascript', '.cjs': 'javascript'}
CONDITIONS = {'if_statement', 'elif_clause', 'while_statement', 'for_statement',
              'conditional_expression', 'ternary_expression', 'switch_statement',
              'switch_expression', 'match_statement', 'case_clause', 'switch_case',
              'switch_expression_arm', 'catch_filter_clause'}
ASSIGNMENTS = {'assignment', 'augmented_assignment', 'assignment_expression',
               'augmented_assignment_expression', 'update_expression',
               'postfix_unary_expression', 'prefix_unary_expression', 'named_expression'}
DECLARATIONS = {'class_declaration', 'class_definition', 'struct_declaration',
                'record_declaration', 'function_declaration', 'function_definition',
                'method_declaration', 'method_definition', 'constructor_declaration',
                'local_function_statement', 'property_declaration'}
CALLS = {'call', 'call_expression', 'invocation_expression'}
CALCULATIONS = {'+', '-', '*', '/', '%', '**', '//', '<<', '>>', '&', '|', '^'}
COMPARISONS = {'<', '<=', '>', '>=', '==', '!=', '===', '!==', '&&', '||', '??',
               'and', 'or', 'in', 'is', 'not in', 'is not'}


def load_engine():
    """A missing native dependency is observable; never substitute regex."""
    try:
        from ast_grep_py import SgRoot
        version = metadata.version(ENGINE_NAME)
    except (ImportError, OSError, metadata.PackageNotFoundError):
        return None, dict(name=ENGINE_NAME, version=ENGINE_VERSION, status='unavailable')
    return SgRoot, dict(name=ENGINE_NAME, version=version, status='available')


def _walk(root):
    stack = [root]
    while stack:
        node = stack.pop()
        yield node
        stack.extend(reversed(node.children()))


def _fingerprint(node):
    tokens = []
    stack = [node]
    while stack:
        current = stack.pop()
        if 'comment' in current.kind():
            continue
        children = current.children()
        if children:
            stack.extend(reversed(children))
        else:
            tokens.append((current.kind(), current.text()))
    value = json.dumps(tokens, ensure_ascii=False, separators=(',', ':'))
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def _name(node):
    name = node.field('name')
    value = name.text() if name else ''
    return value if re.fullmatch(r'[A-Za-z_$][\w$]*', value) else None


def _symbol(node):
    names = []
    for ancestor in reversed(node.ancestors()):
        kind = ancestor.kind()
        name = _name(ancestor) if kind in DECLARATIONS else None
        if kind in ('arrow_function', 'function_expression', 'lambda_expression'):
            parent = ancestor.parent()
            if parent and parent.kind() in ('variable_declarator', 'assignment'):
                name = _name(parent)
                if not name and parent.kind() == 'assignment':
                    left = parent.field('left')
                    name = left.text() if left and left.kind() == 'identifier' else None
        if kind == 'decorated_definition':
            definition = ancestor.field('definition')
            name = _name(definition) if definition else None
        if name and (not names or names[-1] != name):
            names.append(name)
    return '.'.join(names) or None


def _candidate_nodes(node):
    kind = node.kind()
    if kind in CONDITIONS:
        target = next((value for field in ('condition', 'value', 'subject', 'pattern')
                       if (value := node.field(field)) is not None), node)
        while target.kind() == 'parenthesized_expression' and len(target.named_children()) == 1:
            target = target.named_children()[0]
        yield 'condition', target
    elif kind in ('binary_expression', 'binary_operator', 'comparison_operator', 'boolean_operator'):
        operators = {child.text() for child in node.children() if not child.is_named()}
        if operators & CALCULATIONS:
            yield 'calculation', node
        elif operators & COMPARISONS or kind in ('comparison_operator', 'boolean_operator'):
            yield 'condition', node
    elif kind in ASSIGNMENTS:
        if kind not in ('postfix_unary_expression', 'prefix_unary_expression') or any(
                child.text() in ('++', '--') for child in node.children()):
            yield 'state-change', node
    elif kind in ('throw_statement', 'throw_expression', 'raise_statement', 'except_clause', 'catch_clause'):
        yield 'exception', node
    elif kind in ('decorator', 'attribute'):
        yield 'decorator', node
    elif kind == 'assert_statement':
        yield 'validation', node
    elif kind in CALLS:
        callee = node.field('function')
        if callee is not None:
            name = callee.field('name') or callee.field('property') or callee.field('attribute')
            name = name.text() if name else callee.text()
            # These calls warrant review, not automatic classification as rules.
            if re.match(r'(?i)^(?:assert|validate|ensure|require|guard|check)(?:$|_|[A-Z])', name) or name in (
                    'RuleFor', 'NotEmpty', 'NotNull', 'MaximumLength', 'MinimumLength', 'Must', 'IsValid'):
                yield 'validation', node


def source_candidates(source, language, file, parser, repo_id=None):
    # Tree-sitter recovers syntax errors. Python's parser also rejects incomplete
    # suites that can otherwise appear as valid recovered syntax trees.
    if language == 'python':
        ast.parse(source)
    root = parser(source, language).root()
    nodes = list(_walk(root))
    if any(node.kind() == 'ERROR' or (node is not root and node.is_leaf()
           and node.range().start.index == node.range().end.index) for node in nodes):
        raise SyntaxError('incomplete syntax tree')
    candidates = {}
    seen_nodes = set()
    for node in nodes:
        for kind, target in _candidate_nodes(node):
            occurrence = (kind, target.range().start.index, target.range().end.index)
            if occurrence in seen_nodes:
                continue
            seen_nodes.add(occurrence)
            symbol = _symbol(node)
            fingerprint = _fingerprint(target)
            identity = [repo_id, file, language, symbol, kind, fingerprint]
            identifier = 'bc-' + hashlib.sha256(json.dumps(identity, ensure_ascii=False,
                                      separators=(',', ':')).encode('utf-8')).hexdigest()[:24]
            if identifier in candidates:
                candidates[identifier]['occurrences'] += 1
                continue
            candidate = dict(id=identifier, file=file, language=language, kind=kind,
                             fingerprint=fingerprint, anchor={'nodeKind': target.kind()}, occurrences=1)
            if symbol:
                candidate['symbol'] = symbol
            if repo_id is not None:
                candidate['repoId'] = repo_id
            candidates[identifier] = candidate
    return sorted(candidates.values(), key=lambda candidate: candidate['id'])


def scan_business(config, root: Path, atlas: Path, *, repo_id=None, engine=None):
    """Inventory every tracked path; excluded files are classified without reads."""
    from .scanner import DEFAULT_EXCLUDE, excluded

    root, atlas = Path(root).resolve(), Path(atlas).resolve()
    parser, details = load_engine() if engine is None else engine
    files, candidates = [], []
    for file in git_files(root):
        record = dict(file=file)
        if repo_id is not None:
            record['repoId'] = repo_id
        files.append(record)
        language = LANGUAGES.get(Path(file).suffix.lower())
        if language:
            record['language'] = language
        if excluded(file, config.get('exclude', DEFAULT_EXCLUDE)) or (root / file).resolve().is_relative_to(atlas):
            record.update(status='excluded', reason='configured-exclusion-or-generated-output')
            continue
        if language is None:
            record.update(status='unsupported', reason='no-language-adapter')
            continue
        if parser is None:
            record.update(status='unavailable', reason='install-ast-grep-py-' + ENGINE_VERSION)
            continue
        try:
            path = resolve_source(root, file)
            source = path.read_text(encoding='utf-8-sig')
            found = source_candidates(source, language, file, parser, repo_id)
        except (OSError, UnicodeError):
            record.update(status='error', reason='source-unreadable-or-not-utf8')
        except SyntaxError:
            record.update(status='error', reason='source-syntax-error')
        except Exception as exc:
            # Do not serialize exception messages, which can contain source text.
            record.update(status='error', reason='parser-failure-' + type(exc).__name__)
        else:
            record['status'] = 'parsed'
            candidates.extend(found)
    warnings = []
    if details['status'] == 'unavailable':
        warnings.append('Business analysis engine unavailable; install ast-grep-py==' + ENGINE_VERSION + ' and rescan.')
    if any(record['status'] == 'error' for record in files):
        warnings.append('Some tracked source files could not be parsed; inspect businessAnalysis.files before finishing.')
    return dict(engine=details, files=files, candidates=candidates, warnings=warnings)
