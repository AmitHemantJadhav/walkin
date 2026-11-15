#!/usr/bin/env python3
"""Fetch the catalog's photoreal ("hero") models from Poly Haven, CC0, at 1k textures.

The kit models (Kenney, flat-shaded, 25 KB) are what a piece shows the instant you add it; the hero
model replaces it a moment later (furniture.js swapIn). The first two heroes - the sofa and the
armchair - were fetched by hand. This fetches the rest the same way: glTF + .bin + the texture
files the API lists for it, into models/hero/<id>/, skipping anything already there.

  python tools/heroes.py            # every hero furniture.js refers to
  python tools/heroes.py sofa_02    # one by id
"""
import json
import os
import sys
import urllib.request

API = 'https://api.polyhaven.com/files/{id}'
OUT = os.path.join('models', 'hero')

# id -> what it is for. Kept here as the one list; furniture.js names the same files.
HEROES = {
    'Sofa_01': 'sofa',
    'ArmChair_01': 'armchair',
    'dining_chair_02': 'chair',
    'dining_table': 'table',
    'metal_office_desk': 'desk',
    'CoffeeTable_01': 'coffeetable',
    'side_table_01': 'sidetable',
    'ClassicNightstand_01': 'nightstand',
    'modern_wooden_cabinet': 'tvstand',
    'wooden_display_shelves_01': 'bookcase',
    'potted_plant_02': 'plant',
    'potted_plant_04': 'plantsmall',
    'GothicBed_01': 'queen, king',
}


def fetch(url, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return 0
    req = urllib.request.Request(url, headers={'User-Agent': 'walkin-heroes/1 (hackathon; CC0 fetch)'})
    with urllib.request.urlopen(req, timeout=120) as r, open(path, 'wb') as f:
        f.write(r.read())                         # the CDN answers 403 to Python's default agent
    return os.path.getsize(path)


def hero(asset):
    d = json.load(urllib.request.urlopen(urllib.request.Request(API.format(id=asset), headers={'User-Agent': 'walkin-heroes/1'}), timeout=60))
    g = d.get('gltf', {}).get('1k', {}).get('gltf')
    if not g:
        print(f'{asset}: no 1k glTF on Poly Haven')
        return None
    folder = os.path.join(OUT, asset)
    got = fetch(g['url'], os.path.join(folder, os.path.basename(g['url'])))
    for rel, inc in g.get('include', {}).items():
        got += fetch(inc['url'], os.path.join(folder, rel))
    main = os.path.join(folder, os.path.basename(g['url']))
    print(f'{asset:<28} {HEROES.get(asset, ""):<12} {"fetched %.1f MB" % (got / 1e6) if got else "already here":<16} {main}')
    return main


if __name__ == '__main__':
    ids = sys.argv[1:] or list(HEROES)
    for a in ids:
        hero(a)
