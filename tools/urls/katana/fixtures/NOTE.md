# katana fixture

`raw.jsonl` lines 1–11 are real katana v1.8.0 output, captured on 2026-11-24 against the RED WHALE local lab's crawl
site (`pnpm lab:up`, see `lab/README.md`), inside the `redwhale-tools/urls` image on the `redwhale-tools` network, as
user 10001 with a read-only root filesystem, by `run.py --target https://lab.redwhale.test/`. The exact command
`build_command` ran:

```
/usr/local/bin/katana -u https://lab.redwhale.test/ -fs fqdn -dr -d 2 -jc -ndef -ef png,jpg,jpeg,gif,svg,ico,webp,bmp,tif,tiff,avif,woff,woff2,ttf,otf,eot,mp3,mp4,m4a,m4v,avi,mov,mkv,webm,wav,ogg,flac -rl 5 -c 2 -p 1 -ct 210s -timeout 10 -retry 1 -j -or -eof body -silent -nc -duc -r 127.0.0.11:53
```

(`-r` lists the container's own resolver from `/etc/resolv.conf`.) The capture had 11 lines; all are kept, in
katana's order.

- Line 1: the target (no `source`).
- Line 3: `http://…/` answers `301` with `Location: https://elsewhere.…/`: reported, not followed.
- Line 6: `/api/v1/orders`, found only inside `app.js` (`tag` `js`, `attribute` `regex`).
- Line 8: `/item.html`, found by katana's HTML regex in `products.html`. katana also requested
  `/item.html?id=1` (the `a href`), but printed no line for it: same body as `/item.html` (its duplicate-content
  filter).
- Lines 9–10: `deep.html` (three links from home), found twice in `item.html`, not fetched: `"error":"max depth
  reached"`, no `response`. Merged into one finding.

The lab's access log for the run (same window) had 11 requests, all `host=lab.redwhale.test`: no request for
`elsewhere.redwhale.test`, `/static/logo.png`, `/robots.txt`, `/sitemap.xml` or `/contact.html`.

**Anonymized:** `lab.redwhale.test` → `lab.northwind.example`, `elsewhere.redwhale.test` →
`elsewhere.northwind.example`. Nothing else was changed (same fields, order and spacing; timestamps and headers as
captured).

**Edited line** (katana never prints another host with `-fs fqdn`):

- Line 12: a copy of line 11 with the endpoint `https://elsewhere.northwind.example/partners.html` and the source
  `https://lab.northwind.example/` (`a`/`href`): ignored, the second scope check in `parse()`.

`expected.json` is what `run.py --target https://lab.northwind.example/ --replay fixtures/raw.jsonl` must produce.
