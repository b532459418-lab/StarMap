# Security policy

StarMap is a local-first application. In the open-source edition there is no
server, no account, and no cloud storage: everything a user records stays on
their machine. That shapes what a security issue looks like here.

## What counts as a security issue

- Anything that lets the **public build** (`npm run build:public`) read, embed,
  or expose files from the external private layer (`06_private/` or
  `STARMAP_PRIVATE_ROOT`).
- Anything that lets the tracked sample data or the built site leak a
  credential, a private path, or personal media.
- Anything that lets a page other than the loopback development server call
  the local editor endpoints (`/__travelatlas/editor/*`), or lets those
  endpoints write outside the private layer.
- Path traversal, unsafe file handling, or code execution in the media import
  scripts (`scripts/import-media.mjs`) or the editor plugin.
- A dependency with a known vulnerability that is reachable from StarMap.

Provider credentials (Cesium ion, Tianditu, Google Map Tiles) are supplied by
each person who deploys StarMap and are observable in a built static site by
design. That is documented behavior, not a vulnerability; restrict them in the
provider console.

## How to report

Please do **not** open a public issue for a security problem.

Use GitHub's private vulnerability reporting on this repository
("Security" tab → "Report a vulnerability"). If that is unavailable, contact
the maintainer, Jiaxin Yang, through the GitHub profile
[b532459418-lab](https://github.com/b532459418-lab) and ask for a private
channel before sending details.

Include what you found, how to reproduce it, and which version or commit you
tested. You will get an acknowledgement within seven days.

## Never include in a report

Do not paste real tokens, API keys, personal travel data, or personal media
into a report, even a private one. Describe the problem and use neutral sample
data to reproduce it.

## Supported versions

Only the latest release on the `main` branch receives fixes. Older `0.3.x`
releases share history with the upstream project and are not maintained here.
