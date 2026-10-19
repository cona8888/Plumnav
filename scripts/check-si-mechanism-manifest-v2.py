"""Read-only strict metadata/source preflight; no simulation or outcome reading."""
import argparse
import json
from lib.si_mechanism_registry_v2 import Registry

if __name__ == '__main__':
    p=argparse.ArgumentParser();p.add_argument('--manifest',required=True);p.add_argument('--sha256',required=True);a=p.parse_args()
    r=Registry(a.manifest,a.sha256)
    print(json.dumps(dict(passed=True,worlds=len(r.worlds),cases=len(r.cases),purpose=r.document['purpose'],newMissions=0)))
