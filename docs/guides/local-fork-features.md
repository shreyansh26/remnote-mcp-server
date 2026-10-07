# Local folder and semantic-search extensions

This checkout keeps upstream 0.18.0 and adds a paired local bridge contract. Load **RemNote Local Bridge**, not the store plugin. `remnote_status` returns the actual `knowledgeBaseId` and `localFork: true`.

## Native folders

`remnote_create_note` accepts `asFolder: true` with a non-empty `title` and optional `parentId`, tags, and aliases. Folder creation rejects `content` and simultaneous `asDocument`. Use the returned `remIds[0]` as the parent of subfolders or document notes. A titled note under a folder is automatically a document; content-only creation under a folder is rejected. Existing hierarchical Markdown import remains the bullet-writing path.

CLI: `create "Folder" --as-folder`, then `create "Document" --parent-id <folder-id> --content-file <file>`. Existing list/read/move commands work with folder IDs. `folder` is now an exposed Rem classification, preceding document classification.

## Semantic search

- On startup, the server waits for the bridge connection and starts a background refresh. Bridge reconnection also triggers a refresh. After a refresh finishes, the next one runs 15 minutes later by default. Disconnected bridges are skipped, jobs do not overlap, and failures preserve the last usable snapshot and retry on the next interval.
- `remnote_reindex {"action":"start"}` starts a background refresh and returns progress. Poll `{"action":"status"}` until ready or failed. Existing snapshots stay usable during refresh and are preserved on failure.
- `remnote_semantic_search` accepts `query`, `limit` (1–100, default 10), `mode` (`semantic` or default `hybrid`), optional `parentRemId`, and `minScore` (-1–1, default 0). Results expose exact IDs, title/headline, parent context, cosine `score`, and hybrid `rankScore` when requested.
- CLI: `reindex --start`, `reindex`, `semantic-search "query" --mode semantic --parent-id <id> --min-score 0`.
- Search embeds all exported note text/back text, aliases, and parent context, rather than reranking only keyword matches. Long text is chunked and results are deduplicated by Rem ID.
- The internal bridge action `export_notes` pages an SDK `getAll()` ID snapshot without the keyword search's 1,000-result cap. It is an implementation detail of reindex, not a separately exposed MCP/CLI command.
- Reindex reuses unchanged chunks, removes deleted Rems, isolates KBs/model identities, and publishes a private atomic JSONL snapshot only when export and embeddings succeed. Records stream to disk with Float32 vectors, avoiding V8's large-string ceiling. A model digest change requires a rebuild.
- Automatic scans pick up direct RemNote edits, including changes made while the server was off. MCP/CLI writes mark the running index dirty. Results remain snapshots: request an immediate reindex when needed and read returned IDs for current content. No UI-event subscription or OCR/PDF parsing is included.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `REMNOTE_OLLAMA_URL` | `http://127.0.0.1:11434` | Plain loopback HTTP URL; remote URLs, credentials, redirects, and URL paths are rejected. |
| `REMNOTE_EMBEDDING_MODEL` | `embeddinggemma` | Installed Ollama embedding model. The default uses EmbeddingGemma retrieval prefixes. Pull a new model explicitly before using it. |
| `REMNOTE_SEMANTIC_DIR` | `~/.remnote-mcp-server/semantic` | Private plaintext snapshot directory. The paired launcher uses `.runtime/semantic` alongside the two repos. |
| `REMNOTE_SEMANTIC_REFRESH_MINUTES` | `15` | Minutes between completed refreshes. Integer 1–35791; `0` disables both startup and periodic refresh. Manual `reindex --start` remains available. |

Ollama is checked on the first indexing/query request. A ready service is reused. Otherwise the MCP server starts `ollama serve` on the configured loopback address. Shutdown terminates only that owned child. Missing models return a clear `ollama pull` instruction; downloads are not hidden inside tool calls.

There is no extra database, embedding SDK, or Python runtime. The current in-memory vector scan and JSON persistence are intended for local use; migrate after measured scale makes them insufficient.
