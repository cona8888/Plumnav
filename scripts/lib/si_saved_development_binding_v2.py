"""Explicit engine-to-reduced status mapping; raw saved records stay unchanged."""
from lib.si_saved_development_binding_v1 import need, project as project_v1
from lib.si_release_endpoint_v2 import endpoint


def mapped_record(record, field):
    need(field in ('si-continuous', 'si-pulse', 'blank'), 'Unknown field for status mapping')
    expected = 'absent' if field == 'blank' else 'emitting'
    need(record['config']['targetStatus'] == expected, 'Raw engine target status mismatch')
    return dict(record, config=dict(record['config'], targetStatus='absent' if field == 'blank' else 'present'))


def project(record, spec, done):
    return project_v1(mapped_record(record, spec['field']), spec, done)


def extract(record, spec, done):
    meta = dict(auditPassed=True, **project(record, spec, done))
    return dict(metadata=meta, endpoint=endpoint(meta))
