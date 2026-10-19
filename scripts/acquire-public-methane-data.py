"""Bounded official-file download; immutable bytes and safe provenance only."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import urllib.request
import zipfile
import io

FILES = [
    ('watch4ers_readme', 'README.md', 'https://datadryad.org/downloads/file_stream/3937146', '10.5061/dryad.gf1vhhn0j'),
    ('watch4ers', 'Riddick_WATCH4ERS_-_Data.xlsx', 'https://datadryad.org/downloads/file_stream/3936961', '10.5061/dryad.gf1vhhn0j'),
    ('epa_transect', 'Methane Transect Data Set.xlsx', 'https://pasteur.epa.gov/uploads/10.23719/1390071/Methane%20Transect%20Data%20Set.xlsx', '10.23719/1390071'),
]

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    a.output.mkdir(parents=True, exist_ok=False)
    rows = []
    for key, name, url, doi in FILES:
        row = dict(id=key, doi=doi, filename=name, requestedUrl=url, startedAt=datetime.now(timezone.utc).isoformat())
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'PlumeNav-research-data-admission/1.0'})
            with urllib.request.urlopen(request, timeout=30) as response:
                body = response.read(20 * 1024 * 1024 + 1)
                row.update(finalUrl=response.url, httpStatus=response.status, headers={k: response.headers[k] for k in ['Content-Type', 'Content-Length', 'Content-Disposition', 'ETag', 'Last-Modified'] if k in response.headers})
            if len(body) > 20 * 1024 * 1024:
                raise ValueError('Response exceeded 20 MiB admission cap')
            row.update(bytes=len(body), sha256=hashlib.sha256(body).hexdigest())
            # Preserve successful HTTP bytes even if content validation fails.
            with (a.output / name).open('xb') as f:
                f.write(body)
            if name.endswith('.xlsx'):
                with zipfile.ZipFile(io.BytesIO(body)) as book:
                    if '[Content_Types].xml' not in book.namelist() or 'xl/workbook.xml' not in book.namelist():
                        raise ValueError('Missing XLSX workbook members')
                    if book.testzip() is not None:
                        raise ValueError('Corrupt ZIP member')
                row['contentValidated'] = 'xlsx-zip-structure-only'
            else:
                text = body.decode('utf-8')
                if '<html' in text[:500].lower() or not text.strip():
                    raise ValueError('Unexpected HTML/empty README')
                row['contentValidated'] = 'nonempty-utf8-not-html'
            row['status'] = 'downloaded'
        except Exception as e:
            row.update(status='failed', error=f'{type(e).__name__}: {e}')
        row['finishedAt'] = datetime.now(timezone.utc).isoformat()
        rows.append(row)
        with (a.output / f'{key}.receipt.json').open('x') as f:
            json.dump(row, f, indent=2)
            f.write('\n')
        print(json.dumps(row), flush=True)
    manifest = dict(schemaVersion='public-methane-acquisition-v1', files=rows, complete=all(r['status']=='downloaded' for r in rows), scientificAdmission=False, scriptSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    with (a.output / 'acquisition.json').open('x') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')

if __name__ == '__main__':
    main()
