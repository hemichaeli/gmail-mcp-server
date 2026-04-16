import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
import {
  gmailGet, gmailPost, gmailDelete,
  buildRawEmail, parseFullMessage, handleGmailError, formatBytes
} from '../gmail-client';
import { GmailMessage } from '../types';

interface ListMessagesResponse {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

interface BatchModifyResponse {
  id?: string;
}

export function registerMessageTools(server: McpServer): void {

  server.registerTool(
    'gmail_list_messages',
    {
      title: 'List Gmail Messages',
      description: `List Gmail messages with optional filtering. Supports Gmail search query syntax.

Common query examples:
  - "is:unread" - unread messages
  - "from:boss@example.com" - from specific sender
  - "subject:invoice" - subject contains word
  - "has:attachment" - messages with attachments
  - "after:2024/01/01" - after a date
  - "label:important is:unread" - unread important messages
  - "in:inbox" - messages in inbox
  - "in:sent" - sent messages

Returns list of message IDs. Use gmail_get_message to fetch full content.

Args:
  - query: Gmail search query string (optional)
  - maxResults: number of results (1-500, default: 20)
  - pageToken: token for next page of results
  - labelIds: filter by specific label IDs
  - includeSpamTrash: include spam and trash (default: false)`,
      inputSchema: {
        query: z.string().optional().describe('Gmail search query, e.g. "is:unread from:boss@example.com"'),
        maxResults: z.number().int().min(1).max(500).default(20).describe('Number of results (1-500)'),
        pageToken: z.string().optional().describe('Page token for pagination from previous response'),
        labelIds: z.array(z.string()).optional().describe('Filter by label IDs, e.g. ["INBOX", "UNREAD"]'),
        includeSpamTrash: z.boolean().default(false).describe('Include spam and trash folders'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ query, maxResults, pageToken, labelIds, includeSpamTrash }) => {
      try {
        const params: Record<string, unknown> = { maxResults, includeSpamTrash };
        if (query) params['q'] = query;
        if (pageToken) params['pageToken'] = pageToken;
        if (labelIds?.length) params['labelIds'] = labelIds.join(',');

        const data = await gmailGet<ListMessagesResponse>('/users/me/messages', params);
        const messages = data.messages || [];

        const text = messages.length === 0
          ? `No messages found${query ? ` for query: "${query}"` : ''}`
          : `Found ${messages.length} message(s) (estimated total: ${data.resultSizeEstimate || 0}).${data.nextPageToken ? ` Use pageToken: "${data.nextPageToken}" for next page.` : ''}\n\n` +
            messages.map((m, i) => `${i + 1}. ID: ${m.id} | Thread: ${m.threadId}`).join('\n');

        return { content: [{ type: 'text', text }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
      }
    }
  );

  server.registerTool(
    'gmail_get_message',
    {
      title: 'Get Gmail Message',
      description: `Fetch the full content of a Gmail message by ID including decoded body text.

Returns decoded headers (From, To, Subject, Date), body text, HTML body (if available), labels, and metadata.

Args:
  - messageId: Gmail message ID (from gmail_list_messages)
  - format: "full" (default, decoded body), "minimal" (metadata only), "raw" (RFC 2822 base64)
  - metadataHeaders: specific headers to include when format is "metadata"`,
      inputSchema: {
        messageId: z.string().describe('Gmail message ID, e.g. "18a2b3c4d5e6f7g8"'),
        format: z.enum(['full', 'minimal', 'raw', 'metadata']).default('full')
          .describe('Response format: full=decoded body, minimal=metadata, raw=RFC2822'),
        metadataHeaders: z.array(z.string()).optional()
          .describe('Specific headers to return when format="metadata", e.g. ["From","Subject"]'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ messageId, format, metadataHeaders }) => {
      try {
        const params: Record<string, unknown> = { format };
        if (metadataHeaders?.length) params['metadataHeaders'] = metadataHeaders.join(',');

        const msg = await gmailGet<GmailMessage>(`/users/me/messages/${messageId}`, params);

        if (format === 'full') {
          const parsed = parseFullMessage(msg);
          const text = [
            `ID: ${parsed.id}`,
            `Thread ID: ${parsed.threadId}`,
            `From: ${parsed.from}`,
            `To: ${parsed.to}`,
            ...(parsed.cc ? [`Cc: ${parsed.cc}`] : []),
            `Subject: ${parsed.subject}`,
            `Date: ${parsed.date}`,
            `Labels: ${parsed.labelIds.join(', ') || 'none'}`,
            ...(parsed.sizeEstimate ? [`Size: ${formatBytes(parsed.sizeEstimate)}`] : []),
            ``,
            `--- BODY ---`,
            parsed.body || msg.snippet || '(no body text)',
            ...(parsed.htmlBody ? [``, `--- HTML BODY (truncated) ---`, parsed.htmlBody.slice(0, 2000)] : []),
          ].join('\n');
          return { content: [{ type: 'text', text }] };
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              id: msg.id,
              threadId: msg.threadId,
              labelIds: msg.labelIds,
              snippet: msg.snippet,
              sizeEstimate: msg.sizeEstimate,
              internalDate: msg.internalDate,
              payload: format === 'raw' ? msg.raw : msg.payload,
            }, null, 2)
          }]
        };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
      }
    }
  );

  server.registerTool(
    'gmail_send_message',
    {
      title: 'Send Gmail Message',
      description: `Send a new email via Gmail. Builds a properly formatted RFC 2822 MIME email.
Supports plain text and HTML emails, CC, and BCC.

Args:
  - to: list of recipient email addresses
  - subject: email subject line
  - body: plain text body (always required as fallback)
  - htmlBody: optional HTML body (creates multipart/alternative message)
  - cc: optional list of CC recipients
  - bcc: optional list of BCC recipients
  - threadId: optional thread ID to add message to existing thread`,
      inputSchema: {
        to: z.array(z.string().email()).min(1).describe('Recipient email addresses'),
        subject: z.string().min(1).describe('Email subject line'),
        body: z.string().describe('Plain text email body'),
        htmlBody: z.string().optional().describe('HTML email body (optional, creates multipart email)'),
        cc: z.array(z.string().email()).optional().describe('CC recipients'),
        bcc: z.array(z.string().email()).optional().describe('BCC recipients'),
        threadId: z.string().optional().describe('Thread ID to append message to existing thread'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async ({ to, subject, body, htmlBody, cc, bcc, threadId }) => {
      try {
        const raw = buildRawEmail({ to, subject, body, htmlBody, cc, bcc });
        const payload: Record<string, string> = { raw };
        if (threadId) payload['threadId'] = threadId;

        const result = await gmailPost<GmailMessage>('/users/me/messages/send', payload);
        return {
          content: [{
            type: 'text',
            text: `Email sent successfully!\nMessage ID: ${result.id}\nThread ID: ${result.threadId}`
          }]
        };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
      }
    }
  );

  server.registerTool(
    'gmail_reply_to_message',
    {
      title: 'Reply to Gmail Message',
      description: `Reply to an existing Gmail message, keeping it in the same thread.

Fetches the original message to get thread ID, subject, and Message-ID header,
then sends a properly threaded reply with In-Reply-To and References headers.

Args:
  - messageId: ID of the message to reply to
  - body: reply body text
  - htmlBody: optional HTML reply body
  - replyAll: if true, reply-all (preserves CC); if false, reply only to sender (default: false)
  - additionalTo: extra recipients to add beyond original sender`,
      inputSchema: {
        messageId: z.string().describe('ID of the message to reply to'),
        body: z.string().describe('Reply body text'),
        htmlBody: z.string().optional().describe('HTML reply body (optional)'),
        replyAll: z.boolean().default(false).describe('If true, reply-all preserving original CC'),
        additionalTo: z.array(z.string().email()).optional().describe('Additional recipients to add'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async ({ messageId, body, htmlBody, replyAll, additionalTo }) => {
      try {
        const original = await gmailGet<GmailMessage>(`/users/me/messages/${messageId}`, { format: 'full' });
        const parsed = parseFullMessage(original);
        const headers = original.payload?.headers || [];
        const messageIdHeader = headers.find(h => h.name.toLowerCase() === 'message-id')?.value;
        const referencesHeader = headers.find(h => h.name.toLowerCase() === 'references')?.value;

        const replyTo = [parsed.from, ...(additionalTo || [])];
        const cc = replyAll && parsed.cc ? [parsed.cc] : undefined;
        const subject = parsed.subject.startsWith('Re:') ? parsed.subject : `Re: ${parsed.subject}`;
        const references = [referencesHeader || '', messageIdHeader || ''].filter(Boolean).join(' ').trim();

        const raw = buildRawEmail({
          to: replyTo, cc, subject, body, htmlBody,
          inReplyTo: messageIdHeader,
          references: references || undefined,
        });

        const result = await gmailPost<GmailMessage>('/users/me/messages/send', {
          raw,
          threadId: original.threadId,
        });

        return {
          content: [{
            type: 'text',
            text: `Reply sent!\nMessage ID: ${result.id}\nThread ID: ${result.threadId}\nTo: ${replyTo.join(', ')}`
          }]
        };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
      }
    }
  );

  server.registerTool(
    'gmail_forward_message',
    {
      title: 'Forward Gmail Message',
      description: `Forward an existing Gmail message to new recipients.

Fetches the original message content and sends it with a "Fwd:" prefix and original message quoted.

Args:
  - messageId: ID of the message to forward
  - to: list of recipient email addresses
  - body: optional intro text before the forwarded message
  - cc: optional CC recipients`,
      inputSchema: {
        messageId: z.string().describe('ID of the message to forward'),
        to: z.array(z.string().email()).min(1).describe('Recipient email addresses'),
        body: z.string().default('').describe('Optional intro text before forwarded content'),
        cc: z.array(z.string().email()).optional().describe('CC recipients'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async ({ messageId, to, body, cc }) => {
      try {
        const original = await gmailGet<GmailMessage>(`/users/me/messages/${messageId}`, { format: 'full' });
        const parsed = parseFullMessage(original);

        const forwardedBody = [
          body, '',
          '---------- Forwarded message ---------',
          `From: ${parsed.from}`,
          `Date: ${parsed.date}`,
          `Subject: ${parsed.subject}`,
          `To: ${parsed.to}`,
          '',
          parsed.body,
        ].join('\n');

        const subject = parsed.subject.startsWith('Fwd:') ? parsed.subject : `Fwd: ${parsed.subject}`;
        const raw = buildRawEmail({ to, cc, subject, body: forwardedBody });
        const result = await gmailPost<GmailMessage>('/users/me/messages/send', { raw });

        return {
          content: [{
            type: 'text',
            text: `Message forwarded!\nMessage ID: ${result.id}\nTo: ${to.join(', ')}`
          }]
        };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
      }
    }
  );

  server.registerTool(
    'gmail_trash_message',
    {
      title: 'Move Gmail Message to Trash',
      description: `Move a Gmail message to the Trash. Recoverable within 30 days.
For permanent deletion, use gmail_delete_message instead.`,
      inputSchema: {
        messageId: z.string().describe('Gmail message ID to move to trash'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
    },
    async ({ messageId }) => {
      try {
        await gmailPost<GmailMessage>(`/users/me/messages/${messageId}/trash`);
        return { content: [{ type: 'text', text: `Message ${messageId} moved to Trash.` }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
      }
    }
  );

  server.registerTool(
    'gmail_untrash_message',
    {
      title: 'Restore Gmail Message from Trash',
      description: `Restore a Gmail message from the Trash back to the Inbox.`,
      inputSchema: {
        messageId: z.string().describe('Gmail message ID to restore from trash'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ messageId }) => {
      try {
        await gmailPost<GmailMessage>(`/users/me/messages/${messageId}/untrash`);
        return { content: [{ type: 'text', text: `Message ${messageId} restored from Trash.` }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
      }
    }
  );

  server.registerTool(
    'gmail_delete_message',
    {
      title: 'Permanently Delete Gmail Message',
      description: `PERMANENTLY delete a Gmail message. This action is irreversible.
For recoverable deletion, use gmail_trash_message instead.`,
      inputSchema: {
        messageId: z.string().describe('Gmail message ID to permanently delete (IRREVERSIBLE)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async ({ messageId }) => {
      try {
        await gmailDelete(`/users/me/messages/${messageId}`);
        return { content: [{ type: 'text', text: `Message ${messageId} permanently deleted.` }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
      }
    }
  );

  server.registerTool(
    'gmail_modify_labels',
    {
      title: 'Modify Gmail Message Labels',
      description: `Add or remove labels on a Gmail message.

System label IDs: INBOX, SENT, DRAFT, SPAM, TRASH, UNREAD, STARRED, IMPORTANT,
CATEGORY_PERSONAL, CATEGORY_SOCIAL, CATEGORY_PROMOTIONS, CATEGORY_UPDATES, CATEGORY_FORUMS

Use gmail_list_labels to get custom label IDs.`,
      inputSchema: {
        messageId: z.string().describe('Gmail message ID'),
        addLabelIds: z.array(z.string()).optional().describe('Label IDs to add, e.g. ["STARRED", "IMPORTANT"]'),
        removeLabelIds: z.array(z.string()).optional().describe('Label IDs to remove, e.g. ["UNREAD"]'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ messageId, addLabelIds, removeLabelIds }) => {
      try {
        const result = await gmailPost<GmailMessage>(`/users/me/messages/${messageId}/modify`, {
          addLabelIds: addLabelIds || [],
          removeLabelIds: removeLabelIds || [],
        });
        return {
          content: [{
            type: 'text',
            text: `Labels updated for message ${messageId}.\nCurrent labels: ${(result.labelIds || []).join(', ')}`
          }]
        };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
      }
    }
  );

  server.registerTool(
    'gmail_mark_as_read',
    {
      title: 'Mark Gmail Message as Read',
      description: `Mark a Gmail message as read by removing the UNREAD label.`,
      inputSchema: {
        messageId: z.string().describe('Gmail message ID to mark as read'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ messageId }) => {
      try {
        await gmailPost<GmailMessage>(`/users/me/messages/${messageId}/modify`, { removeLabelIds: ['UNREAD'] });
        return { content: [{ type: 'text', text: `Message ${messageId} marked as read.` }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
      }
    }
  );

  server.registerTool(
    'gmail_mark_as_unread',
    {
      title: 'Mark Gmail Message as Unread',
      description: `Mark a Gmail message as unread by adding the UNREAD label.`,
      inputSchema: {
        messageId: z.string().describe('Gmail message ID to mark as unread'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ messageId }) => {
      try {
        await gmailPost<GmailMessage>(`/users/me/messages/${messageId}/modify`, { addLabelIds: ['UNREAD'] });
        return { content: [{ type: 'text', text: `Message ${messageId} marked as unread.` }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
      }
    }
  );

  server.registerTool(
    'gmail_star_message',
    {
      title: 'Star/Unstar Gmail Message',
      description: `Star or unstar a Gmail message.`,
      inputSchema: {
        messageId: z.string().describe('Gmail message ID to star or unstar'),
        starred: z.boolean().default(true).describe('true to star, false to unstar'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ messageId, starred }) => {
      try {
        await gmailPost<GmailMessage>(`/users/me/messages/${messageId}/modify`, {
          addLabelIds: starred ? ['STARRED'] : [],
          removeLabelIds: starred ? [] : ['STARRED'],
        });
        return { content: [{ type: 'text', text: `Message ${messageId} ${starred ? 'starred' : 'unstarred'}.` }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
      }
    }
  );

  server.registerTool(
    'gmail_batch_modify',
    {
      title: 'Batch Modify Gmail Messages',
      description: `Modify labels on multiple Gmail messages at once (up to 1000). More efficient than calling gmail_modify_labels repeatedly.`,
      inputSchema: {
        ids: z.array(z.string()).min(1).max(1000).describe('List of message IDs to modify'),
        addLabelIds: z.array(z.string()).optional().describe('Label IDs to add to all messages'),
        removeLabelIds: z.array(z.string()).optional().describe('Label IDs to remove from all messages'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ ids, addLabelIds, removeLabelIds }) => {
      try {
        await gmailPost<BatchModifyResponse>('/users/me/messages/batchModify', {
          ids,
          addLabelIds: addLabelIds || [],
          removeLabelIds: removeLabelIds || [],
        });
        return {
          content: [{
            type: 'text',
            text: `Batch modify applied to ${ids.length} message(s).\nAdded: ${(addLabelIds || []).join(', ') || 'none'}\nRemoved: ${(removeLabelIds || []).join(', ') || 'none'}`
          }]
        };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
      }
    }
  );
}
