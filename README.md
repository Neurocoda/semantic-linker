# Semantic Linker

Semantic Linker helps you discover semantically related notes from local metadata and add curated links from an Obsidian-style graph.

It is designed for study workflows where filenames and frontmatter are already meaningful. Semantic Linker indexes note titles, filenames, tags, descriptions, type, and kind. It does not embed full note bodies.

## Features

- Show a local semantic graph for the active note in the right sidebar.
- Display existing links as connected context nodes.
- Display unlinked but related notes as candidate nodes.
- Move more relevant candidates closer to the center.
- Click a candidate node to add it to the configured Links section.
- Click a connected node to remove it from the configured Links section.
- Drag nodes, pan, zoom, hover labels, show arrows, and play a lightweight timelapse animation.
- Use Ollama Native embeddings, defaulting to `http://localhost:11434` and `bge-m3`.
- Use OpenAI-compatible `/v1/embeddings` providers.
- Tune ranking weights, graph display, insert templates, and URL strategy.
- Optionally enable feedback-aware ranking.

## Usage

1. Configure your embedding provider in Semantic Linker settings.
2. Rebuild the local index from the plugin settings.
3. Open a note and open the Semantic Linker sidebar.
4. Click a candidate node to insert a link.
5. Click a connected node to remove the link from the configured Links section.

Already linked notes are shown as context nodes, but they are not shown as candidate recommendations.

## Link template

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

## Manual installation

Copy these files into `VaultFolder/.obsidian/plugins/semantic-linker/`:

- `manifest.json`
- `main.js`
- `styles.css`

Then enable **Semantic Linker** in Obsidian community plugin settings.

## License

MIT
