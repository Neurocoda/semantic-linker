# Semantic Linker

Semantic Linker recommends semantically related notes from local metadata and lets you curate links from an Obsidian-style local graph.

It is designed for study workflows where filenames and frontmatter are already meaningful. Version 1 focuses on metadata quality instead of full-note embeddings: `title`, filename, `tags`, `description`, `type`, and `kind`.

## Features

- Local graph in the right sidebar for the active note.
- Center node for the current note, connected context nodes for existing links, and candidate nodes for unlinked recommendations.
- Candidate nodes move closer to the center as semantic relevance increases.
- Click a candidate node to insert a link into the configured Links section.
- Click a connected node to remove that target from the configured Links section.
- Drag nodes, pan, zoom, hover labels, show arrows, and play a lightweight timelapse animation.
- Ollama Native embeddings, defaulting to `http://localhost:11434` and `bge-m3`.
- OpenAI-compatible `/v1/embeddings` provider support.
- Local metadata index with field-specific vectors and lexical matching.
- Filtering of notes already linked by the active note.
- RRF fusion, weighted feature scoring, and MMR diversity.
- Configurable ranking weights, graph display, insert template, and URL strategy.
- Optional feedback-aware ranking, disabled by default.

## How it works

Semantic Linker builds a local index from Markdown filenames and selected frontmatter fields. It does not embed full note bodies in the current release.

Recommendations combine embedding similarity, tag overlap, lexical matching, type/kind hints, existing graph signals, and diversity. Already linked notes are shown as context nodes, but they are not shown as candidate recommendations.

The default insertion section is:

```markdown
## Links
```

The default template is:

```markdown
- [{{description}}]({{url}})
```

Template variables include `title`, `filename`, `basename`, `path`, `description`, `url`, `wikiLink`, `markdownLink`, `obsidianUri`, `tags`, and `score`.

## Network use and privacy

Semantic Linker only makes network requests when it calls the embedding provider you configure.

- Ollama Native uses your configured Ollama base URL, defaulting to `http://localhost:11434`.
- OpenAI-compatible mode sends embedding requests to your configured API base URL at `/v1/embeddings`.
- The plugin sends metadata text used for embeddings, not full note bodies.
- API keys are stored in Obsidian plugin data (`data.json`) and are not written to logs by the plugin.
- Index files and feedback records are stored locally under the plugin cache folder.
- There is no client-side telemetry, no ads, and no self-update mechanism.

Because the plugin uses local cache files and desktop-only APIs, it is marked as desktop-only.

## Feedback-aware ranking

Feedback-aware ranking is disabled by default because click and insert history can introduce sample bias before it has been validated for your vault.

If enabled, Semantic Linker records local interaction signals such as inserted, opened, dismissed, and removed links, and uses them as a light ranking signal. Feedback records never leave your vault. You can disable feedback-aware ranking or clear feedback records from the plugin settings.

## Installation for development

1. Clone this repository into `VaultFolder/.obsidian/plugins/semantic-linker/`.
2. Run `npm install`.
3. Run `npm run build`.
4. Enable **Semantic Linker** in Obsidian community plugin settings.

## Manual installation

Download a release and copy these files into `VaultFolder/.obsidian/plugins/semantic-linker/`:

- `manifest.json`
- `main.js`
- `styles.css`

## Development

```bash
npm install
npm test
npm run lint
npm run build
```

Run `npm run check-release` before publishing a release.

## Release notes for maintainers

Before publishing a release:

1. Run `npm version <version>` to update `package.json`, sync `manifest.json` and `versions.json`, create the version commit, and create the matching tag.
2. Run `npm run check-release`.
3. Push the commit to `main`.
4. Push the tag. GitHub Actions will create a draft release with `manifest.json`, `main.js`, and `styles.css`.
5. Review the draft release notes and publish the release.

For first submission to the Obsidian Community directory, make sure the default branch contains the same `manifest.json` version as the published GitHub release tag.

## License

MIT
