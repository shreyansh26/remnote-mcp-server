import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Logger } from './logger.js';

const NoteSchema = z.object({
  remId: z.string().min(1),
  title: z.string(),
  headline: z.string(),
  remType: z.string(),
  parentRemId: z.string().optional(),
  parentTitle: z.string().optional(),
  aliases: z.array(z.string()).optional(),
});
const ChunkSchema = NoteSchema.extend({
  text: z.string(),
  vector: z.array(z.number().finite()).min(1),
});
const IndexSchema = z.object({
  version: z.literal(2),
  knowledgeBaseId: z.string().min(1),
  model: z.string().min(1),
  modelDigest: z.string().min(1),
  indexedAt: z.string(),
  chunks: z.array(ChunkSchema),
});
const HeaderSchema = IndexSchema.omit({ chunks: true });
const StoredChunkSchema = ChunkSchema.extend({ vector: z.string().min(4) });
const ExportPageSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  notes: z.array(NoteSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().optional(),
  totalRems: z.number().int().nonnegative(),
});
type Index = z.infer<typeof IndexSchema>;
type Chunk = z.infer<typeof ChunkSchema>;
type BridgeRequest = (
  action: string,
  payload: Record<string, unknown>,
  timeoutMs?: number
) => Promise<unknown>;

export const SemanticSearchSchema = z
  .object({
    query: z.string().trim().min(1).max(8000),
    limit: z.number().int().min(1).max(100).default(10),
    mode: z.enum(['semantic', 'hybrid']).default('hybrid'),
    parentRemId: z.string().min(1).optional(),
    minScore: z.number().min(-1).max(1).default(0),
  })
  .strict();
export const ReindexSchema = z
  .object({ action: z.enum(['start', 'status']).default('status') })
  .strict();

export interface IndexStatus {
  status: 'idle' | 'indexing' | 'ready' | 'failed';
  model: string;
  knowledgeBaseId: string;
  indexedNotes: number;
  processedNotes: number;
  indexedAt?: string;
  totalRems?: number;
  dirty: boolean;
  error?: string;
}

export class SemanticSearch {
  private readonly url: URL;
  private readonly model: string;
  private readonly directory: string;
  private readonly abort = new AbortController();
  private ollama?: ChildProcess;
  private startingOllama?: Promise<void>;
  private job?: Promise<void>;
  private jobStatus?: IndexStatus;
  private current?: Index;
  private dirty = false;
  private writeGeneration = 0;
  private readonly refreshIntervalMs: number;
  private refreshTimer?: NodeJS.Timeout;
  private autoRefreshing = false;

  constructor(
    private readonly request: BridgeRequest,
    env = process.env
  ) {
    this.url = new URL(env.REMNOTE_OLLAMA_URL || 'http://127.0.0.1:11434');
    if (
      this.url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(this.url.hostname) ||
      this.url.username ||
      this.url.password ||
      this.url.search ||
      this.url.hash ||
      this.url.pathname !== '/'
    ) {
      throw new Error(
        'REMNOTE_OLLAMA_URL must be a plain local HTTP URL; notes stay on this machine'
      );
    }
    this.model = env.REMNOTE_EMBEDDING_MODEL || 'embeddinggemma';
    this.directory = env.REMNOTE_SEMANTIC_DIR || join(homedir(), '.remnote-mcp-server', 'semantic');
    const refreshMinutes = Number(env.REMNOTE_SEMANTIC_REFRESH_MINUTES ?? '15');
    if (!Number.isInteger(refreshMinutes) || refreshMinutes < 0 || refreshMinutes > 35791) {
      throw new Error(
        'REMNOTE_SEMANTIC_REFRESH_MINUTES must be an integer from 0 to 35791 (0 disables automatic refresh)'
      );
    }
    this.refreshIntervalMs = refreshMinutes * 60_000;
  }

  close(): void {
    clearTimeout(this.refreshTimer);
    this.abort.abort();
    this.ollama?.kill(); // Only the child started here; never an existing Ollama service.
  }

  startAutoRefresh(isConnected: () => boolean, logger: Logger): void {
    if (this.abort.signal.aborted || this.autoRefreshing || this.refreshIntervalMs === 0) return;
    clearTimeout(this.refreshTimer);
    this.autoRefreshing = true;
    void (async () => {
      try {
        if (isConnected()) {
          logger.info('Automatic semantic refresh started');
          await this.reindex('start');
          await this.job;
          if (this.jobStatus?.status === 'failed') throw new Error(this.jobStatus.error);
          logger.info(this.jobStatus, 'Automatic semantic refresh completed');
        }
      } catch (error) {
        if (!this.abort.signal.aborted)
          logger.warn(
            { err: error },
            'Automatic semantic refresh failed; retrying on the next interval'
          );
      } finally {
        this.autoRefreshing = false;
        if (!this.abort.signal.aborted) {
          // ponytail: scan the full KB and reuse embeddings; use SDK change events if scans become too costly.
          this.refreshTimer = setTimeout(
            () => this.startAutoRefresh(isConnected, logger),
            this.refreshIntervalMs
          ).unref();
        }
      }
    })();
  }

  markDirty(): void {
    this.dirty = true;
    this.writeGeneration++;
  }

  private async knowledgeBaseId(): Promise<string> {
    const status = z
      .object({ knowledgeBaseId: z.string().min(1) })
      .safeParse(await this.request('get_status', {}));
    if (!status.success)
      throw new Error(
        'Load the local bridge fork in RemNote; its knowledgeBaseId is required for semantic search'
      );
    return status.data.knowledgeBaseId;
  }

  private file(knowledgeBaseId: string): string {
    const key = createHash('sha256')
      .update(`${knowledgeBaseId}\0${this.model}\0${this.url.origin}`)
      .digest('hex');
    return join(this.directory, `${key}.jsonl`);
  }

  private async load(knowledgeBaseId: string): Promise<Index | undefined> {
    if (this.current?.knowledgeBaseId === knowledgeBaseId) return this.current;
    let handle;
    try {
      handle = await open(this.file(knowledgeBaseId), 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const input = handle.createReadStream({ encoding: 'utf8', autoClose: false });
    const reader = createInterface({ input, crlfDelay: Infinity });
    let readError: Error | undefined;
    input.once('error', (error) => {
      readError = error;
      reader.close();
    });
    let header: z.infer<typeof HeaderSchema> | undefined;
    const chunks: Chunk[] = [];
    try {
      for await (const line of reader) {
        if (!header) {
          header = HeaderSchema.parse(JSON.parse(line));
          continue;
        }
        const { vector: encoded, ...chunk } = StoredChunkSchema.parse(JSON.parse(line));
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.length === 0 || bytes.length % 4 !== 0 || bytes.toString('base64') !== encoded) {
          throw new Error('Corrupt semantic vector encoding; run remnote_reindex action=start');
        }
        const vector = Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readFloatLE(i * 4));
        if (vector.some((value) => !Number.isFinite(value)))
          throw new Error('Corrupt semantic vector values');
        chunks.push({ ...chunk, vector });
      }
      if (readError) throw readError;
      if (!header) throw new Error('Empty semantic index; run remnote_reindex action=start');
    } finally {
      reader.close();
      input.destroy();
      await handle.close();
    }
    const index: Index = { ...header, chunks };
    if (index.knowledgeBaseId !== knowledgeBaseId || index.model !== this.model) {
      throw new Error('Semantic index identity mismatch; run remnote_reindex action=start');
    }
    const dimension = index.chunks[0]?.vector.length;
    if (
      index.chunks.some(
        (chunk) =>
          chunk.vector.length !== dimension || Math.abs(Math.hypot(...chunk.vector) - 1) > 0.00001
      )
    ) {
      throw new Error('Semantic index has inconsistent vectors; run remnote_reindex action=start');
    }
    this.current = index;
    return index;
  }

  private async api(path: string, body?: unknown, timeoutMs = 120000): Promise<unknown> {
    const response = await fetch(new URL(path, this.url), {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)]),
      redirect: 'error',
    });
    if (!response.ok)
      throw new Error(
        `Ollama ${path} failed (${response.status}): ${(await response.text()).slice(0, 500)}`
      );
    return response.json();
  }

  private async ensureOllama(): Promise<void> {
    try {
      await this.api('/api/version', undefined, 1500);
      return;
    } catch {
      if (this.abort.signal.aborted) throw new Error('Semantic search is shutting down');
    }
    this.startingOllama ??= (async () => {
      let launchError: Error | undefined;
      this.ollama = spawn('ollama', ['serve'], {
        stdio: 'ignore',
        env: { ...process.env, OLLAMA_HOST: this.url.host },
      });
      this.ollama.once('error', (error) => {
        launchError = error;
      });
      for (let attempt = 0; attempt < 20; attempt++) {
        await delay(500, undefined, { signal: this.abort.signal });
        if (launchError)
          throw new Error(
            `Cannot start Ollama: ${launchError.message}. Install Ollama or start it manually.`
          );
        try {
          await this.api('/api/version', undefined, 1500);
          return;
        } catch {
          if (this.abort.signal.aborted) throw new Error('Semantic search is shutting down');
        }
      }
      throw new Error('Ollama did not become ready; run ollama serve and retry');
    })()
      .catch((error: unknown) => {
        this.ollama?.kill();
        this.ollama = undefined;
        throw error;
      })
      .finally(() => {
        this.startingOllama = undefined;
      });
    await this.startingOllama;
  }

  private async modelDigest(): Promise<string> {
    await this.ensureOllama();
    const tags = z
      .object({ models: z.array(z.object({ name: z.string(), digest: z.string().min(1) })) })
      .parse(await this.api('/api/tags'));
    const model = tags.models.find(
      (entry) => entry.name === this.model || entry.name === `${this.model}:latest`
    );
    if (!model) throw new Error(`Embedding model missing. Run: ollama pull ${this.model}`);
    return model.digest;
  }

  private async embed(input: string[]): Promise<number[][]> {
    const data = z.object({ embeddings: z.array(z.array(z.number().finite()).min(1)) }).parse(
      await this.api('/api/embed', {
        model: this.model,
        input,
        truncate: false,
        keep_alive: '5m',
      })
    );
    if (data.embeddings.length !== input.length)
      throw new Error('Ollama returned the wrong number of embeddings');
    const dimension = data.embeddings[0]?.length;
    return data.embeddings.map((vector) => {
      const norm = Math.hypot(...vector);
      if (!norm || vector.length !== dimension)
        throw new Error('Ollama returned invalid embedding vectors');
      return vector.map((value) => value / norm);
    });
  }

  async reindex(action: 'start' | 'status'): Promise<IndexStatus> {
    const knowledgeBaseId = await this.knowledgeBaseId();
    if (this.abort.signal.aborted) throw new Error('Semantic search is shutting down');
    if (this.job) {
      if (this.jobStatus?.knowledgeBaseId !== knowledgeBaseId)
        throw new Error('Indexing another knowledge base; wait for it to finish before switching');
      return { ...this.jobStatus!, dirty: this.dirty };
    }
    if (action === 'status' && this.jobStatus?.knowledgeBaseId === knowledgeBaseId) {
      return { ...this.jobStatus, dirty: this.dirty };
    }
    if (action === 'status') {
      const index = await this.load(knowledgeBaseId);
      return {
        status: index ? 'ready' : 'idle',
        model: this.model,
        knowledgeBaseId,
        indexedNotes: new Set(index?.chunks.map((chunk) => chunk.remId)).size,
        processedNotes: 0,
        indexedAt: index?.indexedAt,
        dirty: this.dirty,
      };
    }
    this.jobStatus = {
      status: 'indexing',
      model: this.model,
      knowledgeBaseId,
      indexedNotes: 0,
      processedNotes: 0,
      dirty: this.dirty,
    };
    this.job = this.rebuild(knowledgeBaseId)
      .catch((error: unknown) => {
        this.jobStatus = {
          ...this.jobStatus!,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        };
      })
      .finally(() => {
        this.job = undefined;
      });
    return { ...this.jobStatus };
  }

  private async rebuild(knowledgeBaseId: string): Promise<void> {
    const generation = this.writeGeneration;
    const modelDigest = await this.modelDigest();
    // An explicit rebuild can repair a malformed old index; search still fails closed on corruption.
    const old = await this.load(knowledgeBaseId).catch(() => undefined);
    const reuse = new Map(
      old?.modelDigest === modelDigest ? old.chunks.map((chunk) => [chunk.text, chunk.vector]) : []
    );
    const chunks: Chunk[] = [];
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      if (this.abort.signal.aborted) throw new Error('Indexing cancelled');
      const page = ExportPageSchema.parse(
        await this.request('export_notes', { limit: 100, ...(cursor ? { cursor } : {}) }, 60000)
      );
      if (page.knowledgeBaseId !== knowledgeBaseId)
        throw new Error('Knowledge base changed during indexing; rerun reindex');
      this.jobStatus!.totalRems = page.totalRems;
      const pending: Array<Omit<Chunk, 'vector'>> = [];
      for (const note of page.notes) {
        if (seen.has(note.remId)) continue;
        seen.add(note.remId);
        const body = [note.headline, ...(note.aliases ?? [])].join('\n');
        const title = Array.from(note.title).slice(0, 200).join('');
        const parent = Array.from(note.parentTitle ?? '')
          .slice(0, 100)
          .join('');
        for (const part of body.match(/[\s\S]{1,1200}/gu) ?? ['(untitled)']) {
          const text = `title: ${title} | text: ${parent ? `Parent: ${parent}\n` : ''}${part}`;
          const vector = reuse.get(text);
          if (vector) chunks.push({ ...note, text, vector });
          else pending.push({ ...note, text });
        }
      }
      for (let i = 0; i < pending.length; i += 16) {
        const batch = pending.slice(i, i + 16);
        const vectors = await this.embed(batch.map((chunk) => chunk.text));
        chunks.push(...batch.map((chunk, j) => ({ ...chunk, vector: vectors[j] })));
      }
      this.jobStatus!.processedNotes = seen.size;
      if (page.hasMore && (!page.nextCursor || cursors.has(page.nextCursor)))
        throw new Error('Bridge export cursor did not advance; old index preserved');
      cursor = page.hasMore ? page.nextCursor : undefined;
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if ((await this.knowledgeBaseId()) !== knowledgeBaseId)
      throw new Error('Knowledge base changed during indexing; old index preserved');
    if ((await this.modelDigest()) !== modelDigest)
      throw new Error('Embedding model changed during indexing; old index preserved');
    const dimension = chunks[0]?.vector.length;
    if (chunks.some((chunk) => chunk.vector.length !== dimension))
      throw new Error('Embedding dimensions changed during indexing; old index preserved');
    const index: Index = {
      version: 2,
      knowledgeBaseId,
      model: this.model,
      modelDigest,
      indexedAt: new Date().toISOString(),
      chunks,
    };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.file(knowledgeBaseId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        const { chunks: _chunks, ...header } = index;
        await handle.writeFile(`${JSON.stringify(header)}\n`);
        // Stream records to avoid V8's string-size ceiling on large KBs; Float32 vectors keep disk use bounded.
        for (const chunk of chunks) {
          if (this.abort.signal.aborted) throw new Error('Indexing cancelled');
          const bytes = Buffer.allocUnsafe(chunk.vector.length * 4);
          chunk.vector.forEach((value, i) => bytes.writeFloatLE(value, i * 4));
          await handle.writeFile(
            `${JSON.stringify({ ...chunk, vector: bytes.toString('base64') })}\n`
          );
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
    this.current = index;
    this.dirty = this.writeGeneration !== generation;
    this.jobStatus = {
      ...this.jobStatus!,
      status: 'ready',
      indexedNotes: seen.size,
      indexedAt: index.indexedAt,
      dirty: this.dirty,
    };
  }

  async search(args: z.infer<typeof SemanticSearchSchema>): Promise<Record<string, unknown>> {
    const knowledgeBaseId = await this.knowledgeBaseId();
    const index = await this.load(knowledgeBaseId);
    if (!index)
      throw new Error(
        'No semantic index yet. Run remnote_reindex action=start, then poll action=status until ready'
      );
    if (index.modelDigest !== (await this.modelDigest()))
      throw new Error('Embedding model changed; run remnote_reindex action=start');
    const [queryVector] = await this.embed([`task: search result | query: ${args.query}`]);
    const parents = new Map(index.chunks.map((chunk) => [chunk.remId, chunk.parentRemId]));
    const inScope = (remId: string): boolean => {
      if (!args.parentRemId) return true;
      if (remId === args.parentRemId) return false;
      const visited = new Set<string>();
      let parent = parents.get(remId);
      while (parent && !visited.has(parent)) {
        if (parent === args.parentRemId) return true;
        visited.add(parent);
        parent = parents.get(parent);
      }
      return false;
    };
    const matches = new Map<
      string,
      { chunk: Chunk; score: number; lexical: number; rankScore: number }
    >();
    const terms = [...new Set(args.query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
    // ponytail: flat cosine scan and simple keyword ranks; use a vector DB/BM25 when KB size or ranking quality requires it.
    for (const chunk of index.chunks) {
      if (!chunk.headline.trim() || !inScope(chunk.remId)) continue;
      if (chunk.vector.length !== queryVector.length)
        throw new Error('Embedding dimension mismatch; run remnote_reindex action=start');
      const score = Math.max(
        -1,
        Math.min(
          1,
          chunk.vector.reduce((sum, value, i) => sum + value * queryVector[i], 0)
        )
      );
      const lexical = terms.filter((term) => chunk.text.toLowerCase().includes(term)).length;
      const previous = matches.get(chunk.remId);
      if (!previous || score > previous.score)
        matches.set(chunk.remId, {
          chunk,
          score,
          lexical: Math.max(lexical, previous?.lexical ?? 0),
          rankScore: 0,
        });
      else previous.lexical = Math.max(previous.lexical, lexical);
    }
    const ranked = [...matches.values()].sort(
      (a, b) => b.score - a.score || a.chunk.remId.localeCompare(b.chunk.remId)
    );
    ranked.forEach((entry, i) => {
      entry.rankScore = 1 / (60 + i + 1);
    });
    if (args.mode === 'hybrid') {
      [...ranked]
        .filter((entry) => entry.lexical > 0)
        .sort((a, b) => b.lexical - a.lexical || b.score - a.score)
        .forEach((entry, i) => {
          entry.rankScore += 1 / (60 + i + 1);
        });
      ranked.sort((a, b) => b.rankScore - a.rankScore || b.score - a.score);
    }
    if ((await this.knowledgeBaseId()) !== knowledgeBaseId)
      throw new Error('Knowledge base changed during search; retry');
    return {
      query: args.query,
      mode: args.mode,
      results: ranked
        .filter((entry) => entry.score >= args.minScore)
        .slice(0, args.limit)
        .map(({ chunk, score, rankScore }) => ({
          remId: chunk.remId,
          title: chunk.title,
          headline: chunk.headline,
          remType: chunk.remType,
          parentRemId: chunk.parentRemId,
          parentTitle: chunk.parentTitle,
          aliases: chunk.aliases,
          score,
          ...(args.mode === 'hybrid' ? { rankScore } : {}),
        })),
      index: {
        knowledgeBaseId,
        model: index.model,
        indexedAt: index.indexedAt,
        indexedNotes: parents.size,
        dirty: this.dirty,
      },
      warning: `${this.dirty ? 'Notes changed through MCP/CLI since indexing.' : 'Results use a saved snapshot.'} ${this.refreshIntervalMs ? 'Automatic refresh runs while the server is active.' : 'Automatic refresh is disabled.'} Run remnote_reindex action=start for an immediate refresh and read returned IDs for current content.`,
    };
  }
}
