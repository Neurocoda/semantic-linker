# Semantic Linker

Semantic Linker is an Obsidian plugin that visualizes semantically related notes in a local graph and inserts selected links into a configurable `## Links` section.

The plugin is designed for high-quality note linking during study. It uses filenames, frontmatter `title`, `tags`, `description`, `type`, and `kind`; it does not embed full note bodies in v1.

## Features

- Right sidebar semantic graph for the active note.
- Center node for the current note, connected context nodes for existing links, and candidate nodes for unlinked recommendations.
- Candidate nodes move closer to the center as semantic relevance increases.
- Click a candidate node to insert a link; click a connected node to open that note.
- Ollama Native embeddings, defaulting to `http://localhost:11434` and `bge-m3`.
- OpenAI-compatible `/v1/embeddings` provider support.
- Local metadata index with field-specific vectors and lexical matching.
- Hard filtering of notes already linked by the active note.
- RRF fusion, weighted feature scoring, and MMR diversity.
- Configurable ranking weights from plugin settings.
- Configurable insert template and URL strategy.
- Optional feedback-aware ranking, disabled by default.

## Feedback-aware ranking

Feedback-aware ranking is disabled by default because click and insert history can introduce sample bias before it has been validated for your vault. If enabled, Semantic Linker records local interaction signals such as inserted, opened, and dismissed recommendations and uses them as a light ranking signal.

Feedback never leaves your vault. You can disable feedback-aware ranking or clear feedback records from the plugin settings.

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

## Release notes for maintainers

Before publishing a release:

1. Update `manifest.json`, `package.json`, and `versions.json`.
2. Run `npm run build`.
3. Create a GitHub release whose tag is the exact version, for example `0.1.0`.
4. Attach `manifest.json`, `main.js`, and `styles.css`.

## License

MIT
