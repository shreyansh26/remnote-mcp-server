import { Command } from 'commander';
import { createCommandClient } from '../client/command-client.js';
import { formatResult, formatError, type OutputFormat } from '../output/formatter.js';
import { EXIT } from '../config.js';

/** Default number of search results. */
const DEFAULT_SEARCH_LIMIT = 50;

/** Compact type prefixes for text output (empty for plain text Rems). */
const TYPE_TAG: Record<string, string> = {
  document: '[doc] ',
  dailyDocument: '[daily] ',
  concept: '[concept] ',
  descriptor: '[desc] ',
  portal: '[portal] ',
};

function formatTags(tags: unknown): string {
  if (!Array.isArray(tags)) return '';
  return tags
    .map((tag) => {
      if (
        tag &&
        typeof tag === 'object' &&
        typeof (tag as Record<string, unknown>).name === 'string' &&
        typeof (tag as Record<string, unknown>).tagRemId === 'string'
      ) {
        const { name, tagRemId } = tag as { name: string; tagRemId: string };
        return `${name} [${tagRemId}]`;
      }
      return typeof tag === 'string' ? tag : '';
    })
    .filter(Boolean)
    .join(', ');
}

function applySearchOptions(payload: Record<string, unknown>, opts: Record<string, unknown>): void {
  if (opts.contentMode) payload.contentMode = opts.contentMode;
  if (opts.view) payload.view = opts.view;
  if (opts.ancestorDepth) payload.ancestorDepth = parseInt(opts.ancestorDepth as string, 10);
  if (opts.depth) payload.depth = parseInt(opts.depth as string, 10);
  if (opts.childLimit) payload.childLimit = parseInt(opts.childLimit as string, 10);
  if (opts.maxContentLength)
    payload.maxContentLength = parseInt(opts.maxContentLength as string, 10);
}

function formatSearchText(data: unknown): string {
  const r = data as { results?: Array<Record<string, unknown>> };
  if (!r.results || r.results.length === 0) return 'No results found.';

  const lines = r.results
    .map((note, i) => {
      const typeTag = TYPE_TAG[note.remType as string] ?? '';
      const headline = (note.headline as string) || (note.title as string) || '(untitled)';
      let aliasesSuffix = '';
      if (note.aliases && Array.isArray(note.aliases) && note.aliases.length > 0) {
        aliasesSuffix = ` (aka: ${(note.aliases as string[]).join(', ')})`;
      }
      let tagsSuffix = '';
      const formattedTags = formatTags(note.tags);
      if (formattedTags) {
        tagsSuffix = ` [tags: ${formattedTags}]`;
      }
      let parentSuffix = '';
      if (typeof note.parentTitle === 'string' && note.parentTitle.length > 0) {
        const parentIdSuffix = typeof note.parentRemId === 'string' ? ` [${note.parentRemId}]` : '';
        parentSuffix = ` <- ${note.parentTitle}${parentIdSuffix}`;
      }
      let ancestorSuffix = '';
      if (Array.isArray(note.ancestors) && note.ancestors.length > 0) {
        ancestorSuffix = ` | ancestors: ${note.ancestors
          .map((ancestor) =>
            ancestor && typeof ancestor === 'object'
              ? (ancestor as Record<string, unknown>).title
              : ''
          )
          .filter(Boolean)
          .join(' <- ')}`;
      }
      return `${i + 1}. ${typeTag}${headline}${aliasesSuffix}${tagsSuffix}${parentSuffix}${ancestorSuffix} [${note.remId}]`;
    })
    .join('\n');

  const pagingLines: string[] = [];
  if (
    typeof (r as Record<string, unknown>).nextCursor === 'string' &&
    (r as Record<string, unknown>).hasMore === true
  ) {
    pagingLines.push(`Next cursor: ${(r as Record<string, unknown>).nextCursor as string}`);
  }
  if ((r as Record<string, unknown>).truncated === true) {
    const reason = (r as Record<string, unknown>).truncationReason;
    pagingLines.push(`Results truncated${typeof reason === 'string' ? `: ${reason}` : ''}`);
  }

  return pagingLines.length > 0 ? `${lines}\n${pagingLines.join('\n')}` : lines;
}

function registerCommonSearchOptions(command: Command): Command {
  return command
    .option(
      '-l, --limit <n>',
      `Maximum results (default: ${DEFAULT_SEARCH_LIMIT})`,
      String(DEFAULT_SEARCH_LIMIT)
    )
    .option(
      '--content-mode <mode>',
      'Content rendering mode: "none" (default), "markdown", or "structured"'
    )
    .option('--view <view>', 'Output detail level: compact, standard, or full')
    .option('--ancestor-depth <n>', 'Number of parent Rems to include, direct parent first')
    .option('--depth <n>', 'Depth of child hierarchy to render (default: 1)')
    .option('--child-limit <n>', 'Maximum children per level (default: 20)')
    .option('--max-content-length <n>', 'Maximum content character length (default: 3000)');
}

export function registerSemanticCommands(program: Command): void {
  program
    .command('semantic-search <query>')
    .description('Search by meaning using the local Ollama index')
    .option('-l, --limit <n>', 'Maximum results', '10')
    .option('--mode <mode>', 'semantic or hybrid', 'hybrid')
    .option('--parent-id <remId>', 'Scope to descendants of this Rem')
    .option('--min-score <n>', 'Minimum cosine similarity (-1 to 1)', '0')
    .action(async (query: string, opts) => {
      const format: OutputFormat = program.opts().text ? 'text' : 'json';
      const client = createCommandClient(program);
      try {
        const result = await client.execute('semantic_search', {
          query,
          limit: Number(opts.limit),
          mode: opts.mode,
          minScore: Number(opts.minScore),
          ...(opts.parentId ? { parentRemId: opts.parentId } : {}),
        });
        console.log(
          formatResult(result, format, (data) => {
            const r = data as { results: unknown[]; warning: string };
            return `${formatSearchText(r)}\n${r.warning}`;
          })
        );
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error), format));
        process.exit(EXIT.ERROR);
      } finally {
        await client.close();
      }
    });

  program
    .command('reindex')
    .description('Start a background index refresh or inspect its status')
    .option('--start', 'Start refreshing; without this flag, report status')
    .action(async (opts) => {
      const format: OutputFormat = program.opts().text ? 'text' : 'json';
      const client = createCommandClient(program);
      try {
        const result = await client.execute('reindex', { action: opts.start ? 'start' : 'status' });
        console.log(
          formatResult(result, format, (data) => {
            const r = data as {
              status: string;
              indexedNotes: number;
              processedNotes: number;
              error?: string;
            };
            return `Index ${r.status}: ${r.indexedNotes} indexed, ${r.processedNotes} processed${r.error ? `\n${r.error}` : ''}`;
          })
        );
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error), format));
        process.exit(EXIT.ERROR);
      } finally {
        await client.close();
      }
    });
}

export function registerSearchCommand(program: Command): void {
  registerCommonSearchOptions(
    program.command('search <query>').description('Search for notes in RemNote')
  )
    .option('--cursor <cursor>', 'Opaque cursor returned by a previous search page')
    .option('--parent-id <remId>', "Optional. Scope search to within this Rem's subtree")
    .action(async (query: string, opts) => {
      const globalOpts = program.opts();
      const format: OutputFormat = globalOpts.text ? 'text' : 'json';
      const client = createCommandClient(program);

      try {
        const payload: Record<string, unknown> = {
          query,
          limit: parseInt(opts.limit, 10),
        };
        if (opts.cursor) payload.cursor = opts.cursor;
        if (opts.parentId) payload.parentRemId = opts.parentId;
        applySearchOptions(payload, opts);

        const result = await client.execute('search', payload);
        console.log(formatResult(result, format, (data) => formatSearchText(data)));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(formatError(message, format));
        process.exit(EXIT.ERROR);
      } finally {
        await client.close();
      }
    });
}

export function registerSearchByTagCommand(program: Command): void {
  registerCommonSearchOptions(
    program
      .command('search-by-tag')
      .description('Search notes by exact tag Rem ID with ancestor-context resolution')
      .requiredOption('--tag-id <tagRemId>', 'Exact tag Rem ID to search')
      .option(
        '--result-mode <mode>',
        'Result mode: "context" returns ancestor context targets, "tagged" returns direct tagged Rems'
      )
      .option('--cursor <cursor>', 'Opaque cursor returned by a previous search-by-tag page')
      .option('--timeout-ms <ms>', 'Per-call bridge wait timeout in milliseconds (max: 60000)')
  ).action(async (opts) => {
    const globalOpts = program.opts();
    const format: OutputFormat = globalOpts.text ? 'text' : 'json';
    const client = createCommandClient(program);

    try {
      const payload: Record<string, unknown> = {
        tagRemId: opts.tagId,
        limit: parseInt(opts.limit, 10),
      };
      if (opts.resultMode) payload.resultMode = opts.resultMode;
      if (opts.cursor) payload.cursor = opts.cursor;
      if (opts.timeoutMs) payload.timeoutMs = parseInt(opts.timeoutMs, 10);
      applySearchOptions(payload, opts);

      const result = await client.execute('search_by_tag', payload);
      console.log(formatResult(result, format, (data) => formatSearchText(data)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(formatError(message, format));
      process.exit(EXIT.ERROR);
    } finally {
      await client.close();
    }
  });
}

export function registerListChildrenCommand(program: Command): void {
  program
    .command('list-children <parent-rem-id>')
    .description('List direct child Rems under a parent')
    .option('-l, --limit <n>', 'Maximum direct children (default: 50)', '50')
    .option('--cursor <cursor>', 'Opaque cursor returned by a previous list-children page')
    .option('--view <view>', 'Output detail level: compact, standard, or full')
    .option('--ancestor-depth <n>', 'Number of parent Rems to include, direct parent first')
    .action(async (parentRemId: string, opts) => {
      const globalOpts = program.opts();
      const format: OutputFormat = globalOpts.text ? 'text' : 'json';
      const client = createCommandClient(program);

      try {
        const payload: Record<string, unknown> = {
          parentRemId,
          limit: parseInt(opts.limit, 10),
        };
        if (opts.cursor) payload.cursor = opts.cursor;
        if (opts.view) payload.view = opts.view;
        if (opts.ancestorDepth) payload.ancestorDepth = parseInt(opts.ancestorDepth, 10);

        const result = await client.execute('list_children', payload);
        console.log(
          formatResult(result, format, (data) => {
            const r = data as Record<string, unknown>;
            return formatSearchText({
              results: r.children,
              hasMore: r.hasMore,
              nextCursor: r.nextCursor,
            });
          })
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(formatError(message, format));
        process.exit(EXIT.ERROR);
      } finally {
        await client.close();
      }
    });
}
