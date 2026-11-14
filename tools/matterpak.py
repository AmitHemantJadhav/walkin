"""Read a MatterPak bundle without downloading it.

The furnished mesh is the one thing Matterport has that the defurnished view doesn't, and it is the
only route to real 3D geometry for the home's own furniture (#104). It ships inside
`model.bundle(id: "mp:matterpak")` as a single `aec.zip`, which on La Mirada is 138 MB — but most of
that is a 412 MB point cloud we have no use for. The textured OBJ is 26.5 MB.

The signed URL honours `Range`, and a zip's directory lives at the *end* of the file, so:

    1. read the last 64 KB and find the End Of Central Directory record
    2. read the central directory it points at, which lists every entry with its offset and size
    3. fetch only the entries we want, by offset

That turns "download 138 MB" into "download the OBJ, its MTL and its textures", about 50 MB, and the
point cloud is never touched.

Usage:
    python3 tools/matterpak.py list zvKHR9DHNjJ            # what's in the bundle, no download
    python3 tools/matterpak.py fetch zvKHR9DHNjJ           # pull the mesh + textures into data/<id>/pak/
"""
import io
import os
import re
import struct
import sys
import zipfile

import requests

API = 'https://api.matterport.com/api/models/graph'


def secret(name):
    v = os.environ.get(name)
    if v:
        return v
    for p in ('.env', '../.env'):
        if os.path.exists(p):
            for line in open(p):
                if line.strip().startswith(name + '='):
                    return line.split('=', 1)[1].strip().strip('"').strip("'")
    sys.exit(f'{name} not found in the environment or ./.env')


S = requests.Session()
S.auth = (secret('MATTERPORT_API_KEY'), secret('MATTERPORT_API_TOKEN'))


def bundle_url(model):
    """The signed URL of the model's MatterPak zip, or None if it has no bundle."""
    r = S.post(API, json={'query': '''query($id: ID!) {
          model(id: $id) { name bundle(id: "mp:matterpak") { availability assets { filename url } } }
        }''', 'variables': {'id': model}}, timeout=60)
    r.raise_for_status()
    d = r.json()
    if d.get('errors'):
        sys.exit(f'graph errors: {d["errors"]}')
    m = (d.get('data') or {}).get('model') or {}
    b = m.get('bundle')
    if not b:
        return None, m.get('name')
    if b.get('availability') != 'unlocked':
        print(f'  bundle availability: {b.get("availability")}')
    for a in b.get('assets') or []:
        if (a.get('filename') or '').endswith('.zip'):
            return a['url'], m.get('name')
    return None, m.get('name')


class RemoteZip:
    """Just enough of a zip reader to list entries and pull a few of them over HTTP Range."""

    def __init__(self, url, session=None):
        self.url = url
        # the signed URL already carries its own auth, so do not send ours to the CDN
        self.s = session or requests.Session()
        # The CDN refuses HEAD (403), so ask for one byte and read the total out of Content-Range.
        # That also proves Range works, which is the thing the whole approach rests on.
        probe = self.s.get(url, headers={'Range': 'bytes=0-0'}, timeout=60)
        probe.raise_for_status()
        cr = probe.headers.get('Content-Range', '')
        if probe.status_code != 206 or '/' not in cr:
            raise RuntimeError(f'no Range support: status {probe.status_code}, Content-Range {cr!r}')
        self.size = int(cr.rsplit('/', 1)[1])
        self.entries = self._directory()

    def _range(self, start, length):
        end = min(start + length - 1, self.size - 1)
        r = self.s.get(self.url, headers={'Range': f'bytes={start}-{end}'}, timeout=120)
        if r.status_code not in (200, 206):
            r.raise_for_status()
        return r.content

    def _directory(self):
        """Find the End Of Central Directory, then read the central directory it points at."""
        tail_len = min(self.size, 65536 + 22)
        tail = self._range(self.size - tail_len, tail_len)
        i = tail.rfind(b'PK\x05\x06')
        if i < 0:
            raise RuntimeError('no End Of Central Directory: not a zip, or the tail is too far in')
        count, cd_size, cd_off = struct.unpack('<HII', tail[i + 10:i + 20])
        if cd_off == 0xFFFFFFFF or count == 0xFFFF:
            # zip64: the real values live in the record just before the locator
            j = tail.rfind(b'PK\x06\x06')
            if j < 0:
                raise RuntimeError('zip64 end record not found')
            count, cd_size, cd_off = struct.unpack('<QQQ', tail[j + 32:j + 56])
        cd = self._range(cd_off, cd_size)
        out, p = [], 0
        while p + 46 <= len(cd) and cd[p:p + 4] == b'PK\x01\x02':
            (comp, csize, usize, nlen, elen, clen) = struct.unpack('<H', cd[p + 10:p + 12]) + \
                struct.unpack('<II', cd[p + 20:p + 28]) + struct.unpack('<HHH', cd[p + 28:p + 34])
            lho, = struct.unpack('<I', cd[p + 42:p + 46])
            name = cd[p + 46:p + 46 + nlen].decode('utf-8', 'replace')
            extra = cd[p + 46 + nlen:p + 46 + nlen + elen]
            if usize == 0xFFFFFFFF or csize == 0xFFFFFFFF or lho == 0xFFFFFFFF:
                usize, csize, lho = _zip64(extra, usize, csize, lho)
            out.append(dict(name=name, compress=comp, csize=csize, usize=usize, header=lho))
            p += 46 + nlen + elen + clen
        return out

    def read(self, entry):
        """Pull one entry by its offset and decompress it."""
        head = self._range(entry['header'], 30)
        nlen, elen = struct.unpack('<HH', head[26:30])
        start = entry['header'] + 30 + nlen + elen
        raw = self._range(start, entry['csize'])
        if entry['compress'] == 0:
            return raw
        import zlib
        return zlib.decompress(raw, -15)


def _zip64(extra, usize, csize, lho):
    p = 0
    while p + 4 <= len(extra):
        hid, hlen = struct.unpack('<HH', extra[p:p + 4])
        if hid == 0x0001:
            vals = extra[p + 4:p + 4 + hlen]
            q = 0
            if usize == 0xFFFFFFFF:
                usize, = struct.unpack('<Q', vals[q:q + 8]); q += 8
            if csize == 0xFFFFFFFF:
                csize, = struct.unpack('<Q', vals[q:q + 8]); q += 8
            if lho == 0xFFFFFFFF:
                lho, = struct.unpack('<Q', vals[q:q + 8]); q += 8
            break
        p += 4 + hlen
    return usize, csize, lho


WANTED = re.compile(r'\.(obj|mtl|jpg|jpeg|png)$', re.I)


def fetch_empty_hires(model):
    """The defurnished *view's* own mesh.

    `prep_house.py` saves `defurnished_50k.obj`, which is 7,509 triangles for a whole house — flat
    enough that real wall detail reads as 8 cm of error, and 40% of the furnished mesh came out
    "furniture" when measured against it. The defurnished view carries a 500k mesh of the same empty
    space, which is the reference the subtraction actually needs.
    """
    r = S.post(API, json={'query':
        'query($id: ID!){ model(id:$id){ view(type:"matterport.model.defurnished"){ id } } }',
        'variables': {'id': model}}, timeout=60)
    r.raise_for_status()
    view = (((r.json().get('data') or {}).get('model') or {}).get('view') or {}).get('id')
    if not view:
        return None
    r = S.post(API, json={'query':
        'query($id: ID!){ model(id:$id){ assets{ meshes(formats:"obj"){ filename resolution url } } } }',
        'variables': {'id': view}}, timeout=60)
    r.raise_for_status()
    meshes = (((r.json().get('data') or {}).get('model') or {}).get('assets') or {}).get('meshes') or []
    best = None
    for me in meshes:
        if me.get('url') and (best is None or 'lod2' in (me.get('filename') or '')):
            best = me
    if not best:
        return None
    out = os.path.join('data', model, 'mesh', best['filename'])
    os.makedirs(os.path.dirname(out), exist_ok=True)
    if os.path.exists(out) and os.path.getsize(out) > 0:
        print(f'  already have {out} ({os.path.getsize(out)/1e6:.1f} MB)')
        return out
    with requests.get(best['url'], stream=True, timeout=300) as resp:
        resp.raise_for_status()
        with open(out, 'wb') as f:
            for chunk in resp.iter_content(1 << 20):
                f.write(chunk)
    print(f'  wrote {out} ({os.path.getsize(out)/1e6:.1f} MB, resolution {best.get("resolution")})')
    return out


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'list'
    model = sys.argv[2] if len(sys.argv) > 2 else 'zvKHR9DHNjJ'
    if cmd == 'empty':
        print(f'{model}: fetching the defurnished view\'s own mesh')
        if not fetch_empty_hires(model):
            sys.exit('no defurnished mesh available')
        return
    url, name = bundle_url(model)
    if not url:
        sys.exit(f'{model} ({name}): no MatterPak bundle')
    z = RemoteZip(url)
    total = sum(e['usize'] for e in z.entries)
    want = [e for e in z.entries if WANTED.search(e['name'])]
    skip = [e for e in z.entries if not WANTED.search(e['name'])]
    print(f'{model} {name}: {len(z.entries)} entries, zip {z.size/1e6:.1f} MB, '
          f'{total/1e6:.1f} MB uncompressed')
    print(f'  want {len(want)} files, {sum(e["usize"] for e in want)/1e6:.1f} MB uncompressed '
          f'({sum(e["csize"] for e in want)/1e6:.1f} MB over the wire)')
    for e in sorted(skip, key=lambda e: -e['usize'])[:4]:
        print(f'  skip {e["name"]}  {e["usize"]/1e6:.1f} MB')
    for e in sorted(want, key=lambda e: -e['usize'])[:6]:
        print(f'  take {e["name"]}  {e["usize"]/1e6:.1f} MB')

    if cmd != 'fetch':
        return
    out = os.path.join('data', model, 'pak')
    os.makedirs(out, exist_ok=True)
    done = 0
    for e in want:
        dest = os.path.join(out, os.path.basename(e['name']))
        if os.path.exists(dest) and os.path.getsize(dest) == e['usize']:
            done += 1
            continue
        with open(dest, 'wb') as f:
            f.write(z.read(e))
        done += 1
        print(f'\r  fetched {done}/{len(want)}', end='', flush=True)
    print(f'\n  wrote {out}')


if __name__ == '__main__':
    main()
