## Summary

<!-- What changed and why. One bounded change per pull request. -->

## Edition check

<!-- Keep one line. See docs/editions.md. -->
- [ ] This capability belongs in StarMap Core: a user can use it locally, without an account or network.

## Test plan

Run from `01_Web/` (see CONTRIBUTING.md):

- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build:public`
- [ ] `npm run privacy:check`
- [ ] Manual checks relevant to this change (list them)

## Documentation

- [ ] `README.md` and `README.zh.md` updated together, or not affected
- [ ] `THIRD_PARTY_NOTICES.md` updated if a dependency, dataset, or online service was added

## Privacy

- [ ] No tokens, private paths, personal travel data, or personal media in this diff
