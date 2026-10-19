"""One bounded public author-copy acquisition; no auth or automatic retry."""
import argparse
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import urllib.request

p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);a=p.parse_args()
a.output.mkdir(parents=True,exist_ok=False)
url='https://lisc.mae.cornell.edu/LISCpapers/ESandT_JohnMethane2016.pdf'
r=dict(doi='10.1021/acs.est.5b05059',url=url,startedAt=datetime.now(timezone.utc).isoformat(),route='public corresponding research-group copy linked by exact-title search',expectedFile='ESandT_JohnMethane2016.pdf',singleAttempt=True)
try:
    with urllib.request.urlopen(url,timeout=30) as response:
        data=response.read(20*1024*1024+1)
        assert len(data)<=20*1024*1024 and data.startswith(b'%PDF-'),'Invalid/oversized PDF'
        r.update(finalUrl=response.url,status=response.status,contentType=response.headers.get('Content-Type'))
    with (a.output/r['expectedFile']).open('xb') as f:f.write(data)
    r.update(acquired=True,bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
except Exception as error:r.update(acquired=False,error=str(error))
r['finishedAt']=datetime.now(timezone.utc).isoformat()
with (a.output/'acquisition.json').open('x') as f:json.dump(r,f,indent=2);f.write('\n')
print(json.dumps(r,indent=2))
if not r['acquired']:raise SystemExit(1)
