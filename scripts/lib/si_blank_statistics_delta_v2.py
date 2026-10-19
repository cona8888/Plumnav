"""Constrain v2 changes to endpoint routing, version and blank-only summaries."""
import hashlib
from pathlib import Path

ADDITION="""    for summary in arms:
        if summary['field']=='blank':
            states=[index[w,'blank',summary['arm']] for w in world_keys]
            for category in ('blank-no-nomination','blank-inspection-incomplete','blank-verifier-abstained','blank-supported-report'):
                summary['categories'].setdefault(category,0)
            summary['blankControls']={name:dict(count=sum(state['blankControls'][name] for state in states),denominator=n,proportion=sum(state['blankControls'][name] for state in states)/n) for name in ('falseNomination','inspectionCompleted','falseReport')}
"""

def check():
    old=Path('scripts/lib/si_paired_statistics_v1.py');new=Path('scripts/lib/si_paired_statistics_v2.py')
    text=old.read_text()
    for before,after in [('from lib.si_release_endpoint_v1 import endpoint','from lib.si_release_endpoint_v2 import endpoint'),("VERSION='paired-availability-statistics-v1'","VERSION='paired-availability-statistics-v2'")]:
        assert text.count(before)==1;text=text.replace(before,after)
    marker="    raw=indices.astype('<u4').tobytes(order='C')"
    assert text.count(marker)==1;text=text.replace(marker,ADDITION+marker)
    assert text==new.read_text(),'Undeclared statistics change'
    return dict(passed=True,substitutions=2,blankOnlyInsertion=True,oldSha256=hashlib.sha256(old.read_bytes()).hexdigest(),newSha256=hashlib.sha256(new.read_bytes()).hexdigest())
