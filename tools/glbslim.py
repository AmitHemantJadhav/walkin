"""Slim a GLB for phones: drop the vertex attributes no material uses, then repack the binary.

Some Sketchfab exports carry many UV sets (the bed in #138 had TEXCOORD_0..9, ~13 MB of it) and three.js uploads
every attribute to the GPU. This keeps TEXCOORD_n only if a material's texture reads set n (texCoord, including
KHR_texture_transform's override), drops COLOR_n when asked, and rewrites the BIN chunk with only the buffer views
something still points at. Geometry, materials and textures are otherwise byte-identical.

Usage: python3 tools/glbslim.py file.glb [more.glb ...] [--drop-colors]
"""
import json
import struct
import sys


def read_glb(path):
    data = open(path, 'rb').read()
    magic, version, _ = struct.unpack_from('<III', data, 0)
    assert magic == 0x46546C67 and version == 2, f'{path}: not a glTF 2 GLB'
    off, gltf, binc = 12, None, b''
    while off < len(data):
        ln, typ = struct.unpack_from('<II', data, off)
        chunk = data[off + 8: off + 8 + ln]
        if typ == 0x4E4F534A:
            gltf = json.loads(chunk.decode('utf-8'))
        elif typ == 0x004E4942:
            binc = chunk
        off += 8 + ln
    return gltf, binc


def used_texcoords(gltf):
    sets = {0}

    def visit(o):
        if isinstance(o, dict):
            if isinstance(o.get('index'), int):          # inside materials, only texture references have an index
                sets.add(o.get('texCoord', 0))
                tt = (o.get('extensions') or {}).get('KHR_texture_transform') or {}
                if 'texCoord' in tt:
                    sets.add(tt['texCoord'])
            for v in o.values():
                visit(v)
        elif isinstance(o, list):
            for v in o:
                visit(v)
    visit(gltf.get('materials', []))
    return sets


def slim(path, drop_colors=False):
    gltf, binc = read_glb(path)
    keep_tc = used_texcoords(gltf)
    dropped = 0
    for mesh in gltf.get('meshes', []):
        for prim in mesh.get('primitives', []):
            attrs = prim.get('attributes', {})
            for name in list(attrs):
                if name.startswith('TEXCOORD_') and int(name.split('_')[1]) not in keep_tc:
                    del attrs[name]; dropped += 1
                elif drop_colors and name.startswith('COLOR_'):
                    del attrs[name]; dropped += 1

    # accessors still referenced
    used_acc = set()
    for mesh in gltf.get('meshes', []):
        for prim in mesh.get('primitives', []):
            used_acc.update(prim.get('attributes', {}).values())
            if 'indices' in prim:
                used_acc.add(prim['indices'])
            for t in prim.get('targets', []):
                used_acc.update(t.values())
    for skin in gltf.get('skins', []):
        if 'inverseBindMatrices' in skin:
            used_acc.add(skin['inverseBindMatrices'])
    for anim in gltf.get('animations', []):
        for s in anim.get('samplers', []):
            used_acc.update([s['input'], s['output']])
    acc_map, accessors = {}, []
    for i, a in enumerate(gltf.get('accessors', [])):
        if i in used_acc:
            acc_map[i] = len(accessors); accessors.append(a)

    def remap_acc(prim):
        prim['attributes'] = {k: acc_map[v] for k, v in prim.get('attributes', {}).items()}
        if 'indices' in prim:
            prim['indices'] = acc_map[prim['indices']]
        prim['targets'] = [{k: acc_map[v] for k, v in t.items()} for t in prim.get('targets', [])] or prim.pop('targets', None) or []
        if not prim['targets']:
            del prim['targets']
    for mesh in gltf.get('meshes', []):
        for prim in mesh.get('primitives', []):
            remap_acc(prim)
    for skin in gltf.get('skins', []):
        if 'inverseBindMatrices' in skin:
            skin['inverseBindMatrices'] = acc_map[skin['inverseBindMatrices']]
    for anim in gltf.get('animations', []):
        for s in anim.get('samplers', []):
            s['input'], s['output'] = acc_map[s['input']], acc_map[s['output']]
    gltf['accessors'] = accessors

    # Repack: every accessor gets its own tight buffer view (data copied element by element, so an accessor that
    # shared one big view with the dropped UV sets - the bed's case - no longer drags them along); images keep theirs.
    COMP = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
    NUM = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT2': 4, 'MAT3': 9, 'MAT4': 16}
    old_views = gltf.get('bufferViews', [])
    views, out = [], bytearray()

    def put(chunk, extra):
        while len(out) % 4:
            out.append(0)
        views.append({'buffer': 0, 'byteOffset': len(out), 'byteLength': len(chunk), **extra})
        out.extend(chunk)
        return len(views) - 1

    for a in accessors:
        assert 'sparse' not in a, 'sparse accessors are not handled'
        if 'bufferView' not in a:
            continue
        bv = old_views[a['bufferView']]
        assert bv.get('buffer', 0) == 0, 'only single-buffer GLBs'
        elem = COMP[a['componentType']] * NUM[a['type']]
        stride = bv.get('byteStride') or elem
        base = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        if stride == elem:
            chunk = binc[base: base + elem * a['count']]
        else:
            chunk = b''.join(binc[base + i * stride: base + i * stride + elem] for i in range(a['count']))
        extra = {'target': bv['target']} if 'target' in bv else {}
        a['bufferView'] = put(chunk, extra)
        a.pop('byteOffset', None)
    for img in gltf.get('images', []):
        if 'bufferView' in img:
            bv = old_views[img['bufferView']]
            start = bv.get('byteOffset', 0)
            img['bufferView'] = put(binc[start: start + bv['byteLength']], {})
    gltf['bufferViews'] = views
    while len(out) % 4:
        out.append(0)
    gltf['buffers'] = [{'byteLength': len(out)}]

    js = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
    js += b' ' * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(out)
    before = len(open(path, 'rb').read())
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack('<II', len(out), 0x004E4942)); f.write(out)
    return before, total, dropped, sorted(keep_tc)


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    for p in args:
        b, a, d, keep = slim(p, '--drop-colors' in sys.argv)
        print(f'{p}: {b / 1e6:.1f} MB -> {a / 1e6:.1f} MB, {d} attributes dropped, UV sets kept {keep}')
