#!/usr/bin/env python3
"""Reassemble binary transfer chunks and require the original archive SHA-256."""
import argparse
import hashlib
from pathlib import Path


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--chunks', type=Path, required=True)
    p.add_argument('--part', type=int, choices=range(4), required=True)
    p.add_argument('--count', type=int, required=True)
    p.add_argument('--bytes', type=int, required=True)
    p.add_argument('--sha256', required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    assert 1 <= a.count <= 8 and len(a.sha256) == 64 and a.bytes > 0
    paths = [a.chunks/f'stage2i-campaign-part-{a.part}.tar.chunk{i}' for i in range(a.count)]
    assert all(f.is_file() and not f.is_symlink() for f in paths)
    assert sum(f.stat().st_size for f in paths) == a.bytes
    a.output.mkdir(parents=True, exist_ok=True)
    target = a.output/f'stage2i-campaign-part-{a.part}.tar'
    assert not target.exists()
    partial = target.with_suffix('.tar.partial')
    digest = hashlib.sha256()
    with partial.open('xb') as dst:
        for source in paths:
            with source.open('rb') as src:
                while data := src.read(8*1024*1024):
                    digest.update(data); dst.write(data)
    assert partial.stat().st_size == a.bytes and digest.hexdigest() == a.sha256
    partial.rename(target)
    print(f'VERIFIED {a.sha256} {target}')


if __name__ == '__main__': main()
