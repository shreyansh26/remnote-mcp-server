import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createRequire } from 'node:module';
import { checkVersionCompatibility } from '../version-compat.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../../package.json') as { version: string };

export const BRIDGE_ACTION_TO_TOOL: Readonly<Record<string, string>> = {
  create_note: 'remnote_create_note',
  search: 'remnote_search',
  semantic_search: 'remnote_semantic_search',
  reindex: 'remnote_reindex',
  search_by_tag: 'remnote_search_by_tag',
  read_note: 'remnote_read_note',
  get_media: 'remnote_get_media',
  list_children: 'remnote_list_children',
  move_note: 'remnote_move_note',
  update_note: 'remnote_update_note',
  set_document_status: 'remnote_set_document_status',
  insert_children: 'remnote_insert_children',
  replace_children: 'remnote_replace_children',
  update_tags: 'remnote_update_tags',
  set_property: 'remnote_set_property',
  append_journal: 'remnote_append_journal',
  get_status: 'remnote_status',
  read_table: 'remnote_read_table',
};

type ToolContent = Array<{ type: string; text?: string; data?: string; mimeType?: string }>;

/**
 * Short-lived MCP client used by CLI commands to call remnote-mcp-server.
 */
export class McpServerClient {
  private readonly mcpUrl: string;
  private readonly clientInfo: { name: string; version: string };
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;

  constructor(mcpUrl: string, clientInfo = { name: 'remnote-cli', version: packageJson.version }) {
    this.mcpUrl = normalizeMcpUrl(mcpUrl);
    this.clientInfo = clientInfo;
  }

  async execute(action: string, payload: Record<string, unknown>): Promise<unknown> {
    const toolName = BRIDGE_ACTION_TO_TOOL[action];
    if (!toolName) {
      throw new Error(`Unknown bridge action: ${action}`);
    }

    await this.connect();
    const result = await this.client!.callTool({ name: toolName, arguments: payload });

    if (result.isError) {
      throw new Error(this.extractText(result));
    }

    if (action === 'get_media') {
      const content = result.content as ToolContent | undefined;
      const image = content?.find(
        (item) =>
          item.type === 'image' &&
          typeof item.data === 'string' &&
          typeof item.mimeType === 'string'
      );
      if (!image) {
        throw new Error('MCP server returned media metadata without MCP-native image content');
      }
      const metadata =
        result.structuredContent &&
        typeof result.structuredContent === 'object' &&
        !Array.isArray(result.structuredContent)
          ? result.structuredContent
          : {};
      return { ...metadata, data: image.data, mimeType: image.mimeType };
    }

    const parsed = this.parseResult(result);
    if (action === 'get_status' && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const status = { ...parsed, cliVersion: this.clientInfo.version } as Record<string, unknown>;
      const serverVersion = status.serverVersion;

      if (typeof serverVersion === 'string') {
        const warning = checkVersionCompatibility(
          this.clientInfo.version,
          serverVersion,
          'CLI',
          'MCP server'
        );

        if (warning) {
          status.version_warning =
            typeof status.version_warning === 'string'
              ? `${status.version_warning}\n${warning}`
              : warning;
        }
      }

      return status;
    }

    return parsed;
  }

  async close(): Promise<void> {
    try {
      if (this.transport) {
        await this.transport.terminateSession();
      }
    } catch {
      // Ignore shutdown errors; CLI commands are already done at this point.
    }

    try {
      if (this.client) {
        await this.client.close();
      }
    } catch {
      // Ignore shutdown errors; connection cleanup is best-effort.
    }

    this.client = null;
    this.transport = null;
  }

  private async connect(): Promise<void> {
    if (this.client) {
      return;
    }

    this.transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl));
    this.client = new Client(this.clientInfo);

    try {
      await this.client.connect(this.transport);
    } catch (error) {
      this.client = null;
      this.transport = null;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cannot connect to MCP server at ${this.mcpUrl}. Is remnote-mcp-server running? ${message}`,
        { cause: error }
      );
    }
  }

  private extractText(result: Awaited<ReturnType<Client['callTool']>>): string {
    const content = result.content as ToolContent | undefined;
    const text = content?.find((item) => item.type === 'text' && item.text)?.text;
    return text ?? JSON.stringify(result);
  }

  private parseResult(result: Awaited<ReturnType<Client['callTool']>>): unknown {
    if (
      result.structuredContent &&
      typeof result.structuredContent === 'object' &&
      !Array.isArray(result.structuredContent)
    ) {
      return result.structuredContent;
    }

    const text = this.extractText(result);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { _raw: text };
    }
  }
}

function normalizeMcpUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/mcp')) {
    return trimmed;
  }
  return `${trimmed}/mcp`;
}
