# StarMap editions and licenses

StarMap is one product line with three parts. Each part has its own license and
its own repository. This page is the single place that says which is which.

| Edition | Repository | License | What it is |
| --- | --- | --- | --- |
| **StarMap** (Core / Community Edition) | [b532459418-lab/StarMap](https://github.com/b532459418-lab/StarMap) (this repository) | [MIT](../LICENSE) | Genuinely open source. A complete local-first personal world graph and 3D world atlas that keeps getting real features. |
| **StarMap Plus** | [b532459418-lab/StarMap-Plus](https://github.com/b532459418-lab/StarMap-Plus) | [PolyForm Perimeter 1.0.1](https://polyformproject.org/licenses/perimeter/1.0.1) plus a separate commercial license | Source-available advanced local features layered on top of Core. |
| **StarMap Cloud** | Private | Proprietary | Optional hosted network services: accounts, sync, sharing, social, hosting, billing. |

## How a feature is placed

The test is deliberately simple:

> Can a user, without creating an account and without a network connection,
> complete their whole personal world graph with local StarMap?

If the answer is "this capability belongs to the complete local experience", it
goes into the MIT repository. The open-source edition is a product worth using
on its own; paid editions sell *more convenience, more intelligence, and
connectivity*, never the user's own local features.

**Stays in StarMap (MIT), and keeps growing:**

- World Graph Core, Layer Engine, Layer registry, adapters
- Journey fundamentals, local editor, local data management
- Import / export, public schemas
- Cesium globe capabilities and map interaction improvements
- Basic search, basic media management
- Plugin / Layer SDK
- Bug fixes, performance, accessibility, internationalization, UI improvements

**StarMap Plus (PolyForm Perimeter 1.0.1):**

- Advanced local AI, for example turning a folder of photos into a journey, or
  recognizing places, people, and events automatically
- Cross-layer intelligence across travel, film, music, places, and people
- Semantic search and embedding-based retrieval
- AI recommendations
- Advanced visualization such as story mode, timeline movies, generated yearly
  maps, and graph visualization

**StarMap Cloud (proprietary):**

- Accounts and authentication, cloud sync, multi-device
- Friends, sharing permissions, collaboration
- Hosted media, activity feed, notifications
- Cloud AI and recommendation services
- Team and enterprise features, permissions, audit
- Subscription and billing

## What the licenses actually mean

- **MIT** allows use, copying, modification, distribution, sublicensing, and
  sale. Every version of this repository is and stays MIT; nothing is
  relicensed retroactively. Contributions follow inbound = outbound, see
  [CONTRIBUTING.md](../CONTRIBUTING.md).
- **PolyForm Perimeter 1.0.1** is *not* a "no commercial use" license. Any
  purpose is permitted except providing to others a product that competes with
  the software. Using StarMap Plus inside your company, modifying it, or
  self-hosting it for yourself is allowed. Forking it into a competing product
  or service is not. Uses not permitted under PolyForm Perimeter 1.0.1 may be
  available under a separate commercial license from the StarMap-Plus
  repository. Perimeter is source-available, not OSI open source, because it
  restricts a field of use.
- **StarMap Cloud** is a commercial service. Its source is private.

## Version boundary

| Range | Meaning |
| --- | --- |
| StarMap 0.3.x and earlier | Historical MIT releases, shared history with upstream [Aisland-SJL/StarMap](https://github.com/Aisland-SJL/StarMap) |
| StarMap 0.4.0 and later | Independent MIT Core / Community releases from this repository |
| StarMap Plus 0.1.0 and later | PolyForm Perimeter 1.0.1 |
| StarMap Cloud | Proprietary service |

## Names and logos

The code licenses do not cover the StarMap name or logo. See
[TRADEMARK.md](../TRADEMARK.md).
