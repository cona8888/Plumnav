"""Single-delta derived full auditor; frozen source is never edited."""
import ast
import copy
import hashlib
from pathlib import Path
import types
from lib.si_readout_terminal_audit import terminal_raw_view
from lib.si_scan_disabled_audit import contract as scan_disabled_contract

BASE_PATH = Path(__file__).resolve().parents[1]/'audit-si-readout-full-history.py'
BASE_SHA = '7c2495a787caa72606785c90202251f0f521e8d70d63be440cdb22e049bcbb7c'
OLD = "            close('reportedSourceError',report['sourceErrorMetres'],np.linalg.norm(expected-point(c['sourcePositionOverride']))*L,1e-10)"
NEW = "            if s['field']=='blank':\n                assert report['sourceErrorMetres'] is None\n            else:\n    " + OLD


def dump(node): return ast.dump(node, include_attributes=False)


def derive(raw):
    if hashlib.sha256(raw).hexdigest() != BASE_SHA:
        raise ValueError('Frozen full-auditor source hash mismatch')
    original = raw.decode('utf-8')
    if original.count(OLD) != 1:
        raise ValueError('Expected exactly one replacement site')
    text = original.replace(OLD, NEW)
    old_tree, tree = ast.parse(original), ast.parse(text)
    old_node = ast.parse(OLD.strip()).body[0]
    new_node = ast.parse("if s['field']=='blank':\n    assert report['sourceErrorMetres'] is None\nelse:\n    "+OLD.strip()).body[0]
    class Reverse(ast.NodeTransformer):
        count = 0
        def visit_If(self, node):
            if dump(node) == dump(new_node):
                self.count += 1
                return copy.deepcopy(old_node)
            return self.generic_visit(node)
    reverse = Reverse(); restored = reverse.visit(copy.deepcopy(tree))
    if reverse.count != 1 or dump(restored) != dump(old_tree):
        raise ValueError('Unexpected full-auditor syntax delta')
    return text, dict(baseSha256=BASE_SHA, derivedSha256=hashlib.sha256(text.encode()).hexdigest(),
                      substitutions=1, completeSyntaxTreeReversalPassed=True)


def namespace(text, name):
    values = dict(__name__=name, __file__=str(BASE_PATH))
    exec(compile(text, str(BASE_PATH)+'::'+name, 'exec'), values)
    return types.SimpleNamespace(**values)


def terminal_block(text):
    """Extract the actual block; upstream fit/clock checks are not in this function."""
    tree = ast.parse(text)
    test = ast.parse("if arm['decision']['status']=='supported':\n    pass").body[0].test
    nodes = [node for node in ast.walk(tree) if isinstance(node, ast.If) and dump(node.test) == dump(test)]
    if len(nodes) != 1:
        raise ValueError('Expected one actual terminal report block')
    function = ast.parse('def check_block(arm,nominee,L,report,c,s,close):\n    pass').body[0]
    function.body = [copy.deepcopy(nodes[0])]
    module = ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[]))
    base = namespace(text, 'terminal_block_imports')
    scope = dict(np=base.np, point=base.point)
    exec(compile(module, '<extracted-terminal-block>', 'exec'), scope)
    return scope['check_block']


def audit(record, scan_disabled=False):
    text, guard = derive(BASE_PATH.read_bytes())
    derived = namespace(text, 'derived_absent_report_full_audit_v1')
    if scan_disabled:
        treatment = scan_disabled_contract(record)
        raw, _ = derived.availability_audit(record)
        view = terminal_raw_view(record, raw['controls'][-1]['measurement']['sampleMode'])
        result = derived.audit(view)
        assert result['availability']['scanCount'] == result['availability']['promotedReadouts'] == result['availability']['drainRows'] == 0
        result = dict(**result, scanDisabled=treatment)
    else:
        result = derived.audit(record)
    return result, guard
