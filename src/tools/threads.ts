import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
import {
  gmailGet, gmailPost, gmailDelete,
  parseFullMessage, handleGmailError
} from '../gmail-client';
import { GmailThread } from '../types';

interface ListThreadsResponse {
  threads?: Array<{ id: string; snippet?: string; historyId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export function registerThreadTools(server: McpServer): void {

  server.registerTool(
    'gmail_list_threads',
    {
      title: 'List Gmail Threads',
      description: `List Gmail conversation threads with optional filtering.

Threads group related messages together. Use gmail_get_thread to fetch all messages.
Supports the same Gmail query syntax as gmail_list_messages.

Args:
  - query: Gmail search query, e.g. "is:unread", "from:boss@example.com", "label:work"
  - maxResults: number of threads (1-500, default: 20)
  - pageToken: pagination token
  - labelIds: filter by label IDs, e.g. ["INBOX", "UNREAD"]
  - includeSpamTrash: include spam and trash threads (default: false)`,
      inputSchema: {
        query: z.string().optional().describe('Gmail search query'),
        maxResults: z.number().int().min(1).max(500).default(20).describe('Number of threads to return'),
        pageToken: z.string().optional().describe('Pagination token'),
        labelIds: z.array(z.string()).optional().describe('Filter by label IDs, e.g. ["INBOX", "UNREAD"]'),
        includeSpamTrash: z.boolean().default(false).describe('Include spam and trash'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ query, maxResults, pageToken, labelIds, includeSpamTrash }) => {
      try {
        const params: Record<string, unknown> = { maxResults, includeSpamTrash };
        if (query) params['q'] = query;
        if (pageToken) params['pageToken'] = pageToken;
        if (labelIds?.length) params['labelIds'] = labelIds.join(',');

        const data = await gmailGet<ListThreadsResponse>('/users/me/threads', params);
        const threads = data.threads || [];

        const text = threads.length === 0
          ? `No threads found${query ? ` for query: "${query}"` : ''}`
          : `Found ${threads.length} thread(s) (estimated total: ${data.resultSizeEstimate || 0}).${data.nextPageToken ? ` Next page token: "${data.nextPageToken}"` : ''}\n\n` +
            threads.map((t, i) =>
              `${i + 1}. Thread ID: ${t.id}\n   ${t.snippet || '(no snippet)'}`
            ).join('\n\n');

        return { content: [{ type: 'text', text }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
      }
    }
  );

  server.registerTool(
    'gmail_get_thread',
    {
      title: 'Get Gmail Thread',
      description: `Fetch a Gmail conversation thread with all its messages in chronological order.

Args:
  - threadId: Gmail thread ID (from gmail_list_threads or any message)
  - format: "full" (default, decoded bodies), "minimal" (metadata only), "metadata" (headers only)
  - metadataHeaders: specific headers when format="metadata", e.g. ["From","Subject","Date"]`,
      inputSchema: {
        threadId: z.string().describe('Gmail thread ID'),
        format: z.enum(['full', 'minimal', 'metadata']).default('full')
          .describe('Response format for messages in thread'),
        metadataHeaders: z.array(z.string()).optional()
          .describe('Specific headers when format="metadata", e.g. ["From","Subject","Date"]'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ threadId, format, metadataHeaders }) => {
      try {
        const params: Record<string, unknown> = { format };
        if (metadataHeaders?.length) params['metadataHeaders'] = metadataHeaders.join(',');

        const thread = await gmailGet<GmailThread>(`/users/me/threads/${threadId}`, params);
        const messages = thread.messages || [];

        if (format === 'full') {
          const parts = [
            `Thread ID: ${threadId}`,
            `Messages: ${messages.length}`,
            ``,
          ];

          for (let i = 0; i < messages.length; i++) {
            const parsed = parseFullMessage(messages[i]);
            parts.push(
              `=== Message ${i + 1}/${messages.length} ===`,
              `ID: ${parsed.id}`,
              `From: ${parsed.from}`,
              `To: ${parsed.to}`,
              ...(parsed.cc ? [`Cc: ${parsed.cc}`] : []),
              `Subject: ${parsed.subject}`,
              `Date: ${parsed.date}`,
              `Labels: ${parsed.labelIds.join(', ') || 'none'}`,
              ``,
              parsed.body || messages[i].snippet || '(no body)',
              ``,
            );
          }

          return { content: [{ type: 'text', text: parts.join('\n') }] };
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              id: thread.id,
              historyId: thread.historyId,
              messageCount: messages.length,
              messages: messages.map(m => ({
                id: m.id,
                threadId: m.threadId,
                labelIds: m.labelIds,
                snippet: m.snippet,
                internalDate: m.internalDate,
              })),
            }, null, 2)
          }]
        };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
      }
    }
  );

  server.registerTool(
    'gmail_trash_thread',
    {
      title: 'Move Gmail Thread to Trash',
      description: `Move an entire Gmail conversation thread to Trash. All messages are trashed.
Recoverable within 30 days. For permanent deletion use gmail_delete_thread.`,
      inputSchema: {
        threadId: z.string().describe('Gmail thread ID to move to trash'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
    },
    async ({ threadId }) => {
      try {
        const result = await gmailPost<GmailThread>(`/users/me/threads/${threadId}/trash`);
        const count = result.messages?.length || 0;
        return {
          content: [{
            type: 'text',
            text: `Thread ${threadId} moved to Trash.${count > 0 ? ` (${count} message(s) trashed)` : ''}`
          }]
        };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
      }
    }
  );

  server.registerTool(
    'gmail_delete_thread',
    {
      title: 'Permanently Delete Gmail Thread',
      description: `PERMANENTLY delete a Gmail thread and all its messages. Irreversible.
For recoverable deletion use gmail_trash_thread instead.`,
      inputSchema: {
        threadId: z.string().describe('Gmail thread ID to permanently delete (IRREVERSIBLE)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async ({ threadId }) => {
      try {
        await gmailDelete(`/users/me/threads/${threadId}`);
        return { content: [{ type: 'text', text: `Thread ${threadId} permanently deleted.` }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
      }
    }
  );

  server.registerTool(
    'gmail_modify_thread',
    {
      title: 'Modify Gmail Thread Labels',
      description: `Add or remove labels on all messages in a Gmail thread at once.

Useful for archiving (remove INBOX), starring, or categorizing entire conversations.

Args:
  - threadId: Gmail thread ID
  - addLabelIds: label IDs to add to all messages, e.g. ["STARRED", "IMPORTANT"]
  - removeLabelIds: label IDs to remove from all messages, e.g. ["INBOX", "UNREAD"]`,
      inputSchema: {
        threadId: z.string().describe('Gmail thread ID'),
        addLabelIds: z.array(z.string()).optional()
          .describe('Label IDs to add to all messages in the thread'),
        removeLabelIds: z.array(z.string()).optional()
          .describe('Label IDs to remove from all messages in the thread'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ threadId, addLabelIds, removeLabelIds }) => {
      try {
        const result = await gmailPost<GmailThread>(`/users/me/threads/${threadId}/modify`, {
          addLabelIds: addLabelIds || [],
          removeLabelIds: removeLabelIds || [],
        });
        const count = result.messages?.length || 0;
        return {
          content: [{
            type: 'text',
            text: `Thread ${threadId} labels updated.${count > 0 ? ` (${count} message(s) modified)` : ''}\nAdded: ${(addLabelIds || []).join(', ') || 'none'}\nRemoved: ${(removeLabelIds || []).join(', ') || 'none'}`
          }]
        };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
      }
    }
  );
}
