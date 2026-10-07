import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SemanticSearch, SemanticSearchSchema, ReindexSchema } from '../../src/semantic-search.js';
import { createMockLogger } from '../setup.js';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

type Note = {
  remId: string;
  title: string;
  headline: string;
  remType: string;
  parentRemId?: string;
  parentTitle?: string;
};
const note = (remId: string, title: string, parentRemId?: string): Note => ({
  remId,
  title,
  headline: title,
  remType: 'text',
  parentRemId,
});
describe('local semantic search', () => {
  let dir: string;
  let service: SemanticSearch;
  let notes: Note[];
  let kb: string;
  let digest: string;
  let failEmbed: boolean;
  let invalidVector: boolean;
  let installed: boolean;
  let embedCalls: string[][];
  let request: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'remnote-semantic-'));
    kb = 'kb-one';
    digest = 'digest-one';
    failEmbed = false;
    invalidVector = false;
    installed = true;
    embedCalls = [];
    notes = [
      note('folder', 'Animal studies'),
      note('cat', 'Cats nap in warm places', 'folder'),
      note('dog', 'Dogs enjoy long walks'),
    ];
    request = vi.fn(async (action: string, payload: Record<string, unknown>) => {
      if (action === 'get_status') return { knowledgeBaseId: kb };
      if (action === 'export_notes') {
        const offset = Number(payload.cursor ?? 0);
        const end = offset + Number(payload.limit);
        return {
          knowledgeBaseId: kb,
          notes: notes.slice(offset, end),
          totalRems: notes.length,
          hasMore: end < notes.length,
          nextCursor: end < notes.length ? String(end) : undefined,
        };
      }
      throw new Error(`Unexpected action: ${action}`);
    });
    fetchMock = vi.fn(async (url: URL, options?: RequestInit) => {
      if (url.pathname === '/api/version') return Response.json({ version: 'test' });
      if (url.pathname === '/api/tags')
        return Response.json({
          models: installed ? [{ name: 'embeddinggemma:latest', digest }] : [],
        });
      if (url.pathname === '/api/embed') {
        if (failEmbed)
          return Response.json({ error: 'Model temporarily unavailable' }, { status: 503 });
        const body = JSON.parse(options!.body as string) as { input: string[]; truncate: boolean };
        expect(body.truncate).toBe(false);
        embedCalls.push(body.input);
        return Response.json({
          embeddings: body.input.map((text) =>
            invalidVector
              ? [0, 0, 0]
              : /cat|feline/iu.test(text)
                ? [3, 0, 0]
                : /dog|canine/iu.test(text)
                  ? [0, 5, 0]
                  : [0, 0, 2]
          ),
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    service = new SemanticSearch(request, { REMNOTE_SEMANTIC_DIR: dir });
    spawnMock.mockReset();
  });
  afterEach(async () => {
    service.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });
  async function refresh(): Promise<void> {
    expect((await service.reindex('start')).status).toBe('indexing');
    await vi.waitFor(async () => {
      expect((await service.reindex('status')).status).toBe('ready');
    });
  }
  const search = (query: string, extra = {}) =>
    service.search(SemanticSearchSchema.parse({ query, mode: 'semantic', ...extra }));

  it('validates local endpoints and search bounds', () => {
    for (const url of [
      'https://example.com',
      'http://evil.localhost',
      'http://127.0.0.1/path',
      'http://user:pass@localhost',
      'http://localhost?x=1',
    ]) {
      expect(() => new SemanticSearch(request, { REMNOTE_OLLAMA_URL: url })).toThrow(
        'plain local HTTP URL'
      );
    }
    expect(() => SemanticSearchSchema.parse({ query: ' ', limit: 10 })).toThrow();
    expect(() => SemanticSearchSchema.parse({ query: 'x', limit: -1 })).toThrow();
    expect(() => ReindexSchema.parse({ action: 'delete' })).toThrow();
    for (const value of ['bad', '-1', '0.5', '35792', 'Infinity']) {
      expect(
        () => new SemanticSearch(request, { REMNOTE_SEMANTIC_REFRESH_MINUTES: value })
      ).toThrow('REMNOTE_SEMANTIC_REFRESH_MINUTES');
    }
  });

  it('waits for connection, refreshes manual edits periodically, and stops its timer on close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const connected = vi.fn().mockReturnValue(false);
    const logger = createMockLogger();
    service.startAutoRefresh(connected, logger);
    expect(request).not.toHaveBeenCalled();
    connected.mockReturnValue(true);
    service.startAutoRefresh(connected, logger); // The server invokes this on bridge connection.
    await vi.waitFor(async () => expect((await service.reindex('status')).status).toBe('ready'));
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ indexedNotes: 3 }),
      'Automatic semantic refresh completed'
    );
    embedCalls = [];
    notes = [notes[0], note('cat', 'Canines are friendly'), note('new', 'Felines are nocturnal')];
    // These edits bypass markDirty(), just like edits made directly in RemNote.
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await vi.waitFor(async () =>
      expect((await search('felines', { minScore: 0.5 })).results).toMatchObject([{ remId: 'new' }])
    );
    expect(embedCalls.flat().filter((text) => text.startsWith('title:'))).toHaveLength(2);
    expect(logger.warn).not.toHaveBeenCalled();
    service.close();
    const calls = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(request).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not overlap automatic and manual refreshes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (action: string, payload: Record<string, unknown>) => {
      if (action === 'export_notes') await gate;
      return original(action, payload);
    });
    const logger = createMockLogger();
    service.startAutoRefresh(() => true, logger);
    await vi.waitFor(() =>
      expect(request.mock.calls.some(([action]) => action === 'export_notes')).toBe(true)
    );
    service.startAutoRefresh(() => true, logger);
    expect((await service.reindex('start')).status).toBe('indexing');
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(request.mock.calls.filter(([action]) => action === 'export_notes')).toHaveLength(1);
    release();
    await vi.waitFor(async () => expect((await service.reindex('status')).status).toBe('ready'));
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ indexedNotes: 3 }),
      'Automatic semantic refresh completed'
    );
  });

  it('keeps a usable snapshot after automatic failure and retries on a configurable interval', async () => {
    await refresh();
    service.close();
    service = new SemanticSearch(request, {
      REMNOTE_SEMANTIC_DIR: dir,
      REMNOTE_SEMANTIC_REFRESH_MINUTES: '1',
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    notes.push(note('new', 'Felines are nocturnal'));
    failEmbed = true;
    const logger = createMockLogger();
    service.startAutoRefresh(() => true, logger);
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledOnce());
    failEmbed = false;
    expect((await search('felines', { limit: 1 })).results).toMatchObject([{ remId: 'cat' }]);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(async () => expect((await service.reindex('status')).indexedNotes).toBe(4));
    expect((await search('felines', { minScore: 0.5 })).results).toHaveLength(2);
  });

  it('can disable automatic refresh while retaining manual refresh', async () => {
    service.close();
    service = new SemanticSearch(request, {
      REMNOTE_SEMANTIC_DIR: dir,
      REMNOTE_SEMANTIC_REFRESH_MINUTES: '0',
    });
    const connected = vi.fn().mockReturnValue(true);
    service.startAutoRefresh(connected, createMockLogger());
    expect(connected).not.toHaveBeenCalled();
    await refresh();
    expect((await service.reindex('status')).indexedNotes).toBe(3);
  });

  it('finds a note with different vocabulary and scopes to a folder subtree', async () => {
    await expect(search('felines')).rejects.toThrow('No semantic index yet');
    await refresh();
    const result = await search('felines', { parentRemId: 'folder', minScore: 0.5 });
    expect(result.results).toMatchObject([{ remId: 'cat', score: 1 }]);
    expect(result.results as unknown[]).toHaveLength(1);
    expect((await search('felines', { mode: 'hybrid', limit: 1 })).results).toMatchObject([
      { remId: 'cat', rankScore: expect.any(Number) },
    ]);
    expect((await search('felines', { parentRemId: 'cat' })).results).toEqual([]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('indexes beyond the keyword-search cap and persists a private reloadable snapshot', async () => {
    notes = Array.from({ length: 1005 }, (_, i) => note(`note-${i}`, `Cats ${i}`));
    await refresh();
    expect((await service.reindex('status')).indexedNotes).toBe(1005);
    expect(request.mock.calls.filter(([action]) => action === 'export_notes')).toHaveLength(11);
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const records = (await readFile(join(dir, files[0]), 'utf8')).trim().split('\n');
    expect(records).toHaveLength(1006);
    expect(JSON.parse(records[0]).version).toBe(2);
    expect(typeof JSON.parse(records[1]).vector).toBe('string');
    expect((await stat(join(dir, files[0]))).mode & 0o777).toBe(0o600);
    const restored = new SemanticSearch(request, { REMNOTE_SEMANTIC_DIR: dir });
    try {
      expect((await restored.reindex('status')).indexedNotes).toBe(1005);
      expect(
        (await restored.search(SemanticSearchSchema.parse({ query: 'felines', limit: 1 }))).results
      ).toHaveLength(1);
    } finally {
      restored.close();
    }
  });

  it('reuses unchanged embeddings, refreshes edited notes, and removes deleted notes', async () => {
    await refresh();
    embedCalls = [];
    await refresh();
    expect(embedCalls).toHaveLength(0);
    notes = [note('cat', 'Canines are friendly'), note('new', 'Felines are nocturnal')];
    service.markDirty();
    expect((await service.reindex('status')).dirty).toBe(true);
    await refresh();
    expect(embedCalls.flat()).toHaveLength(2);
    const result = await search('felines', { minScore: 0.5 });
    expect(result.results).toMatchObject([{ remId: 'new' }]);
    expect(result.index).toMatchObject({ indexedNotes: 2, dirty: false });
  });

  it('chunks long Unicode notes and deduplicates search hits by Rem ID', async () => {
    notes = [note('long', '猫🐈'.repeat(1800) + ' felines')];
    await refresh();
    const inputs = embedCalls.flat();
    expect(inputs.length).toBeGreaterThan(1);
    expect(inputs.join('')).toContain('felines');
    for (const input of inputs)
      expect(input).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u
      );
    expect((await search('felines', { minScore: 0.5 })).results).toHaveLength(1);
  });

  it('keeps the previous index when embeddings fail', async () => {
    await refresh();
    const file = join(dir, (await readdir(dir))[0]);
    const before = await readFile(file, 'utf8');
    notes.push(note('new', 'New content'));
    failEmbed = true;
    await service.reindex('start');
    await vi.waitFor(async () => {
      expect((await service.reindex('status')).status).toBe('failed');
    });
    expect((await service.reindex('status')).error).toContain('503');
    expect(await readFile(file, 'utf8')).toBe(before);
    failEmbed = false;
    expect((await search('felines', { limit: 1 })).results).toMatchObject([{ remId: 'cat' }]);
  });

  it('isolates knowledge bases and refuses a changed model', async () => {
    await refresh();
    kb = 'kb-two';
    await expect(search('felines')).rejects.toThrow('No semantic index yet');
    kb = 'kb-one';
    digest = 'updated-digest';
    await expect(search('felines')).rejects.toThrow('Embedding model changed');
    embedCalls = [];
    await refresh();
    expect(embedCalls.flat()).toHaveLength(notes.length);
  });

  it('rejects a stalled export cursor without replacing the old index', async () => {
    await refresh();
    request.mockImplementation(async (action: string) =>
      action === 'get_status'
        ? { knowledgeBaseId: kb }
        : { knowledgeBaseId: kb, notes, totalRems: 300, hasMore: true, nextCursor: 'same' }
    );
    await service.reindex('start');
    await vi.waitFor(async () => {
      expect((await service.reindex('status')).error).toContain('cursor did not advance');
    });
    expect((await search('felines', { limit: 1 })).results).toMatchObject([{ remId: 'cat' }]);
  });

  it('fails clearly for a missing model or invalid vectors', async () => {
    installed = false;
    await service.reindex('start');
    await vi.waitFor(async () => {
      expect((await service.reindex('status')).error).toContain('ollama pull embeddinggemma');
    });
    installed = true;
    invalidVector = true;
    await service.reindex('start');
    await vi.waitFor(async () => {
      expect((await service.reindex('status')).error).toContain('invalid embedding vectors');
    });
    expect(await readdir(dir)).toEqual([]);
  });

  it('fails closed on malformed persisted data and can rebuild it', async () => {
    await refresh();
    const file = join(dir, (await readdir(dir))[0]);
    await writeFile(file, '{broken');
    service.close();
    service = new SemanticSearch(request, { REMNOTE_SEMANTIC_DIR: dir });
    await expect(search('felines')).rejects.toThrow();
    await refresh();
    expect((await search('felines', { limit: 1 })).results).toMatchObject([{ remId: 'cat' }]);
  });

  it('starts Ollama on demand and stops only the child it owns', async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    spawnMock.mockReturnValue(child);
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await refresh();
    expect(spawnMock).toHaveBeenCalledWith(
      'ollama',
      ['serve'],
      expect.objectContaining({ env: expect.objectContaining({ OLLAMA_HOST: '127.0.0.1:11434' }) })
    );
    service.close();
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
