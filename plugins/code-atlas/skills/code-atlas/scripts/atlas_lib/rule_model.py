"""Stable authored rule identities and conservative source/dependency review work."""
from __future__ import annotations

import copy

from .common import AtlasError, read_json


def rule_owners(town):
    """Yield evidence owners, including structured rules, without copying entries."""
    residents = town.get('residents', [])
    for owner in [town, *(residents if isinstance(residents, list) else [])]:
        if not isinstance(owner, dict):
            continue
        yield owner
        rules = owner.get('rules', [])
        if isinstance(rules, list):
            yield from (rule for rule in rules if isinstance(rule, dict))


def owner_evidence(owner):
    """An owner's direct and per-rule references (used for town-level impacts)."""
    entries = list(owner.get('evidence', []))
    rules = owner.get('rules', [])
    if not isinstance(rules, list):
        raise AtlasError('Rules must be an array; repair documents before diff.')
    for rule in rules:
        if isinstance(rule, dict):
            sources = rule.get('evidence', [])
            if not isinstance(sources, list):
                raise AtlasError('Rule evidence must be an array; repair documents before diff.')
            entries.extend(sources)
    return entries


def rule_index(atlas, documents=None):
    result = {}
    paths = ((path, None) for path in sorted((atlas / 'nodes').glob('*/*.json'))) if documents is None else ((path, document) for path, document, _ in documents)
    for path, document in paths:
        if path.name == '_country.json':
            continue
        if not path.resolve().is_relative_to(atlas.resolve()):
            raise AtlasError('Rule document escapes atlas-dir.')
        document = read_json(path) if document is None else document
        for town in document.get('towns', []):
            for owner in [town, *town.get('residents', [])]:
                rules = owner.get('rules', [])
                if not isinstance(rules, list):
                    raise AtlasError('Rules must be an array; repair documents before diff.')
                for rule in rules:
                    if not isinstance(rule, dict):
                        continue
                    identifier = rule.get('id')
                    if not isinstance(identifier, str) or not identifier or identifier in result:
                        raise AtlasError('Rules require unique stable IDs; repair documents before diff.')
                    if (not isinstance(rule.get('evidence'), list)
                            or any(not isinstance(source, dict) or not isinstance(source.get('file'), str) for source in rule['evidence'])
                            or not isinstance(rule.get('dependsOn', []), list)
                            or any(not isinstance(target, str) for target in rule.get('dependsOn', []))):
                        raise AtlasError('Rule evidence/dependencies are invalid; repair documents before diff.')
                    entry = copy.deepcopy(rule)
                    entry['townId'] = town['id']
                    if owner is not town:
                        entry['resident'] = owner.get('name')
                    result[identifier] = entry
    return result


def rule_changes(atlas, state, changes, documents=None):
    """File-level source review plus authored rule changes; never semantic certainty."""
    current = rule_index(atlas, documents)
    previous = (state or {}).get('ruleIndex')
    available = isinstance(previous, dict)
    previous = previous if available else {}
    if any(not isinstance(entry, dict) or not isinstance(entry.get('townId'), str)
           or not isinstance(entry.get('evidence'), list)
           or any(not isinstance(source, dict) for source in entry['evidence'])
           or not isinstance(entry.get('dependsOn', []), list)
           or any(not isinstance(target, str) for target in entry.get('dependsOn', [])) for entry in previous.values()):
        raise AtlasError('Saved rule index is invalid; finish a reviewed analysis to rebuild it.')
    delta = {'added': [], 'modified': [], 'deleted': []}
    affected = {}

    def mark(identifier, entry, reason):
        item = affected.setdefault(identifier, {'id': identifier, 'townId': entry['townId'], 'reasons': []})
        if entry.get('resident'):
            item['resident'] = entry['resident']
        if reason not in item['reasons']:
            item['reasons'].append(reason)

    if available:
        for identifier in sorted(set(previous) | set(current)):
            action = ('added' if identifier not in previous else 'deleted' if identifier not in current
                      else 'modified' if previous[identifier] != current[identifier] else None)
            if action:
                delta[action].append(identifier)
                mark(identifier, current.get(identifier, previous.get(identifier)), {'kind': 'document-' + action})
    for identifier in sorted(set(previous) | set(current)):
        entry = current.get(identifier, previous.get(identifier))
        sources = [*previous.get(identifier, {}).get('evidence', []), *current.get(identifier, {}).get('evidence', [])]
        for change in changes:
            if any(source.get('repoId') == change.get('repoId') and source.get('file') in
                   (change['path'], change.get('oldPath')) for source in sources):
                mark(identifier, entry, {'kind': 'source-change', 'change': change})
    # Cycles are permitted and terminate at the fixed point. Use old dependencies
    # too so removing an upstream rule still asks consumers to reconcile it.
    again = True
    while again:
        again = False
        for identifier in sorted(set(previous) | set(current)):
            entry = current.get(identifier, previous.get(identifier))
            dependencies = set(previous.get(identifier, {}).get('dependsOn', [])) | set(current.get(identifier, {}).get('dependsOn', []))
            for dependency in sorted(dependencies):
                if dependency in affected:
                    was_present = identifier in affected
                    mark(identifier, entry, {'kind': 'dependency', 'ruleId': dependency})
                    again |= not was_present
    return {'affectedRules': list(affected.values()), 'ruleChanges': delta, 'ruleIndexAvailable': available}


def review_candidates(analysis, review, rules, legacy_count, error, warnings, present=False):
    """Validate dispositions separately from endpoint coverage; no completeness claim."""
    analysis = analysis if isinstance(analysis, dict) else {}
    candidates = analysis.get('candidates', [])
    engine = analysis.get('engine', {})
    engine_available = isinstance(engine, dict) and engine.get('status') == 'available'
    if not engine_available:
        warnings.append('Business analysis engine is unavailable or unrecorded; syntax candidate coverage is incomplete')
    files = analysis.get('files', [])
    failures = sum(isinstance(item, dict) and item.get('status') in ('error', 'unavailable') for item in files) if isinstance(files, list) else 0
    unsupported = sum(isinstance(item, dict) and item.get('status') == 'unsupported' for item in files) if isinstance(files, list) else 0
    if failures or unsupported:
        warnings.append(f'Business analysis has {failures} failed/unavailable and {unsupported} unsupported file(s); review scope remains incomplete')
    if not isinstance(candidates, list):
        error('inventory.json.businessAnalysis.candidates', 'must be an array')
        candidates = []
    candidate_ids = set()
    for index, candidate in enumerate(candidates):
        if (not isinstance(candidate, dict) or not isinstance(candidate.get('id'), str)
                or not candidate['id'] or candidate['id'] in candidate_ids):
            error(f'inventory.json.businessAnalysis.candidates[{index}]', 'requires a unique candidate ID')
        else:
            candidate_ids.add(candidate['id'])
    dispositions = {}
    if present:
        if not isinstance(review, dict) or review.get('version') != 1 or isinstance(review.get('version'), bool):
            error('rule-review.json', 'requires version 1')
            review = {}
        if set(review) - {'version', 'reviews'}:
            error('rule-review.json', 'contains unsupported fields')
        entries = review.get('reviews')
        if not isinstance(entries, list):
            error('rule-review.json.reviews', 'must be an array')
            entries = []
        for index, entry in enumerate(entries):
            label = f'rule-review.json.reviews[{index}]'
            if not isinstance(entry, dict):
                error(label, 'must be an object')
                continue
            if set(entry) - {'candidateId', 'status', 'ruleIds', 'reason'}:
                error(label, 'contains unsupported fields')
            candidate = entry.get('candidateId')
            if not isinstance(candidate, str) or candidate not in candidate_ids or candidate in dispositions:
                error(label + '.candidateId', 'must reference a unique current candidate')
                continue
            status = entry.get('status')
            if status not in ('documented', 'not-business', 'uncertain'):
                error(label + '.status', 'must be documented, not-business or uncertain')
            refs = entry.get('ruleIds', [])
            if not isinstance(refs, list) or any(not isinstance(ref, str) or ref not in rules for ref in refs):
                error(label + '.ruleIds', 'must reference existing structured rule IDs')
            elif status == 'documented' and not refs:
                error(label + '.ruleIds', 'documented candidates require at least one rule ID')
            if status in ('not-business', 'uncertain') and (not isinstance(entry.get('reason'), str) or not entry['reason'].strip()):
                error(label + '.reason', 'a nonempty explanation is required')
            dispositions[candidate] = status
    remaining = len(candidate_ids - dispositions.keys())
    uncertain = sum(value == 'uncertain' for value in dispositions.values())
    if remaining:
        warnings.append(f'{remaining} business rule candidate(s) have not been reviewed')
    if not present:
        warnings.append('No rule-review.json: business rule candidate review is not recorded')
    if uncertain:
        warnings.append(f'{uncertain} business rule candidate(s) remain uncertain; candidate review is not semantic completeness')
    if legacy_count:
        warnings.append(f'{legacy_count} legacy text rule(s) lack stable IDs and per-rule source tracking')
    return {'candidateCount': len(candidate_ids), 'reviewedCount': len(dispositions),
            'unreviewedCount': remaining, 'uncertainCount': uncertain,
            'legacyRuleCount': legacy_count, 'structuredRuleCount': len(rules), 'reviewFilePresent': present,
            'engineAvailable': engine_available, 'failedFileCount': failures, 'unsupportedFileCount': unsupported}


def require_review(report):
    review = report['businessReview']
    if review['reviewFilePresent'] and review['unreviewedCount']:
        raise AtlasError('Business rule candidate review is incomplete; resolve every candidate in rule-review.json before finish.')
    if review['reviewFilePresent'] and (not review['engineAvailable'] or review['failedFileCount']):
        raise AtlasError('Business analysis is unavailable or has parse failures; rerun scan with its analysis dependency before finish.')
