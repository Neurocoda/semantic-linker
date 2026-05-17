# Contributing

## Development

```bash
npm install
npm test
npm run lint
npm run build
```

Run `npm run check-release` before publishing.

## Publishing

1. Run `npm version <version>` to update `package.json`, sync `manifest.json` and `versions.json`, create the version commit, and create the matching tag.
2. Run `npm run check-release`.
3. Push the commit to `main`.
4. Push the tag. GitHub Actions will create a draft release with `manifest.json`, `main.js`, and `styles.css`.
5. Review the draft release notes and publish the release.

For first submission to the Obsidian Community directory, make sure the default branch contains the same `manifest.json` version as the published GitHub release tag.
