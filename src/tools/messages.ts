import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  gmailGet, gmailPost, gmailDelete, gmailGetAttachmentData,
  buildRawEmail, parseFullMessage, handleGmailError, formatBytes, EmailAttachment
} from '../gmail-client.js';
import { GmailMessage } from '../types.js';

interface ListMessagesResponse {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

const attachmentSchema = z.array(z.object({
  filename: z.string().describe('Filename including extension, e.g. "report.pdf"'),
  mimeType: z.string().describe('MIME type, e.g. "application/pdf", "image/png", "text/csv"'),
  data: z.string().describe('Base64-encoded file content (standard or URL-safe base64)'),
})).optional().describe('File attachments. Each requires filename, mimeType, and base64-encoded data.');

export function registerMessageTools(server: McpServer): void {

  server.registerTool('gmail_list_messages', {
    title: 'List Gmail Messages',
    description: `List Gmail messages with optional filtering. Supports Gmail search query syntax.

Common queries: "is:unread", "from:boss@example.com", "subject:invoice", "has:attachment",
"after:2024/01/01", "in:inbox", "in:sent", "label:important is:unread"

Returns message IDs. Use gmail_get_message to fetch full content.`,
    inputSchema: {
      query: z.string().optional().describe('Gmail search query'),
      maxResults: z.number().int().min(1).max(500).default(20).describe('Number of results (1-500)'),
      pageToken: z.string().optional().describe('Page token for pagination'),
      labelIds: z.array(z.string()).optional().describe('Filter by label IDs, e.g. ["INBOX", "UNREAD"]'),
      includeSpamTrash: z.boolean().default(false).describe('Include spam and trash'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ query, maxResults, pageToken, labelIds, includeSpamTrash }) => {
    try {
      const params: Record<string, unknown> = { maxResults, includeSpamTrash };
      if (query) params['q'] = query;
      if (pageToken) params['pageToken'] = pageToken;
      if (labelIds?.length) params['labelIds'] = labelIds.join(',');
      const data = await gmailGet<ListMessagesResponse>('/users/me/messages', params);
      const messages = data.messages || [];
      const text = messages.length === 0
        ? `No messages found${query ? ` for query: "${query}"` : ''}`
        : `Found ${messages.length} message(s) (estimated total: ${data.resultSizeEstimate || 0}).${data.nextPageToken ? ` Next page token: "${data.nextPageToken}"` : ''}\n\n` +
          messages.map((m, i) => `${i + 1}. ID: ${m.id} | Thread: ${m.threadId}`).join('\n');
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
    }
  });

  server.registerTool('gmail_get_message', {
    title: 'Get Gmail Message',
    description: `Fetch the full content of a Gmail message by ID including decoded body, headers, labels, and list of attachments.

If the message has attachments, their attachmentId values are returned.
Use gmail_get_attachment to download the actual attachment content.`,
    inputSchema: {
      messageId: z.string().describe('Gmail message ID'),
      format: z.enum(['full', 'minimal', 'raw', 'metadata']).default('full').describe('Response format'),
      metadataHeaders: z.array(z.string()).optional().describe('Headers to return when format="metadata"'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ messageId, format, metadataHeaders }) => {
    try {
      const params: Record<string, unknown> = { format };
      if (metadataHeaders?.length) params['metadataHeaders'] = metadataHeaders.join(',');
      const msg = await gmailGet<GmailMessage>(`/users/me/messages/${messageId}`, params);
      if (format === 'full') {
        const parsed = parseFullMessage(msg);
        const attLines = parsed.attachments.length > 0
          ? [``, `--- ATTACHMENTS (${parsed.attachments.length}) ---`,
             ...parsed.attachments.map((a, i) => `  ${i + 1}. ${a.filename} (${a.mimeType}, ${formatBytes(a.size)}) | attachmentId: ${a.attachmentId}`)]
          : [];
        const text = [
          `ID: ${parsed.id}`, `Thread ID: ${parsed.threadId}`,
          `From: ${parsed.from}`, `To: ${parsed.to}`,
          ...(parsed.cc ? [`Cc: ${parsed.cc}`] : []),
          `Subject: ${parsed.subject}`, `Date: ${parsed.date}`,
          `Labels: ${parsed.labelIds.join(', ') || 'none'}`,
          ...(parsed.sizeEstimate ? [`Size: ${formatBytes(parsed.sizeEstimate)}`] : []),
          ``, `--- BODY ---`,
          parsed.body || msg.snippet || '(no body text)',
          ...(parsed.htmlBody ? [``, `--- HTML BODY (truncated) ---`, parsed.htmlBody.slice(0, 2000)] : []),
          ...attLines,
        ].join('\n');
        return { content: [{ type: 'text', text }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds, snippet: msg.snippet, sizeEstimate: msg.sizeEstimate, internalDate: msg.internalDate }, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
    }
  });

  server.registerTool('gmail_get_attachment', {
    title: 'Get Gmail Message Attachment',
    description: `Download the content of a specific attachment from a Gmail message.

Returns the attachment as base64-encoded data along with its filename and MIME type.
Get the attachmentId from gmail_get_message (listed under ATTACHMENTS section).

Use this to retrieve PDFs, images, spreadsheets, or any other attached file.

Args:
  - messageId: Gmail message ID containing the attachment
  - attachmentId: attachment ID from gmail_get_message
  - filename: original filename (for reference in response)`,
    inputSchema: {
      messageId: z.string().describe('Gmail message ID containing the attachment'),
      attachmentId: z.string().describe('Attachment ID from gmail_get_message'),
      filename: z.string().optional().describe('Filename for reference (optional)'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ messageId, attachmentId, filename }) => {
    try {
      const att = await gmailGetAttachmentData(messageId, attachmentId);
      const sizeBytes = Math.round((att.data.length * 3) / 4);
      return {
        content: [{
          type: 'text',
          text: [
            `Attachment downloaded successfully.`,
            `Filename: ${filename || '(unknown)'}`,
            `Size: ${formatBytes(sizeBytes)}`,
            `Data (base64, URL-safe): ${att.data.slice(0, 100)}...`,
            ``,
            `Full base64 data:`,
            att.data,
          ].join('\n')
        }]
      };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
    }
  });

  server.registerTool('gmail_send_message', {
    title: 'Send Gmail Message',
    description: `Send a new email via Gmail. Supports plain text, HTML, CC, BCC, and file attachments.

Attachments: provide an array of objects with filename, mimeType, and base64-encoded data.
Example attachment: { filename: "report.pdf", mimeType: "application/pdf", data: "<base64>" }

Common mimeTypes: application/pdf, image/png, image/jpeg, text/csv, application/vnd.ms-excel,
application/vnd.openxmlformats-officedocument.spreadsheetml.sheet (xlsx),
application/msword, application/vnd.openxmlformats-officedocument.wordprocessingml.document (docx)`,
    inputSchema: {
      to: z.array(z.string().email()).min(1).describe('Recipient email addresses'),
      subject: z.string().min(1).describe('Email subject line'),
      body: z.string().describe('Plain text email body'),
      htmlBody: z.string().optional().describe('HTML email body (optional, creates multipart email)'),
      cc: z.array(z.string().email()).optional().describe('CC recipients'),
      bcc: z.array(z.string().email()).optional().describe('BCC recipients'),
      threadId: z.string().optional().describe('Thread ID to append to existing thread'),
      attachments: attachmentSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async ({ to, subject, body, htmlBody, cc, bcc, threadId, attachments }) => {
    try {
      const raw = buildRawEmail({ to, subject, body, htmlBody, cc, bcc, attachments: attachments as EmailAttachment[] | undefined });
      const payload: Record<string, string> = { raw };
      if (threadId) payload['threadId'] = threadId;
      const result = await gmailPost<GmailMessage>('/users/me/messages/send', payload);
      return {
        content: [{
          type: 'text',
          text: `Email sent!\nMessage ID: ${result.id}\nThread ID: ${result.threadId}` +
            (attachments?.length ? `\nAttachments: ${attachments.length} file(s) included` : '')
        }]
      };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
    }
  });

  server.registerTool('gmail_reply_to_message', {
    title: 'Reply to Gmail Message',
    description: `Reply to an existing Gmail message, keeping it in the same thread.
Supports plain text, HTML body, reply-all, and file attachments.`,
    inputSchema: {
      messageId: z.string().describe('ID of the message to reply to'),
      body: z.string().describe('Reply body text'),
      htmlBody: z.string().optional().describe('HTML reply body (optional)'),
      replyAll: z.boolean().default(false).describe('If true, reply-all preserving original CC'),
      additionalTo: z.array(z.string().email()).optional().describe('Additional recipients to add'),
      attachments: attachmentSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async ({ messageId, body, htmlBody, replyAll, additionalTo, attachments }) => {
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
      const raw = buildRawEmail({ to: replyTo, cc, subject, body, htmlBody, inReplyTo: messageIdHeader, references: references || undefined, attachments: attachments as EmailAttachment[] | undefined });
      const result = await gmailPost<GmailMessage>('/users/me/messages/send', { raw, threadId: original.threadId });
      return {
        content: [{
          type: 'text',
          text: `Reply sent!\nMessage ID: ${result.id}\nTo: ${replyTo.join(', ')}` +
            (attachments?.length ? `\nAttachments: ${attachments.length} file(s) included` : '')
        }]
      };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
    }
  });

  server.registerTool('gmail_forward_message', {
    title: 'Forward Gmail Message',
    description: `Forward an existing Gmail message to new recipients with "Fwd:" prefix.
The original message content is quoted below your intro text. Supports additional attachments.`,
    inputSchema: {
      messageId: z.string().describe('ID of the message to forward'),
      to: z.array(z.string().email()).min(1).describe('Recipient email addresses'),
      body: z.string().default('').describe('Intro text before the forwarded content'),
      cc: z.array(z.string().email()).optional().describe('CC recipients'),
      attachments: attachmentSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async ({ messageId, to, body, cc, attachments }) => {
    try {
      const original = await gmailGet<GmailMessage>(`/users/me/messages/${messageId}`, { format: 'full' });
      const parsed = parseFullMessage(original);
      const forwardedBody = [body, '', '---------- Forwarded message ---------', `From: ${parsed.from}`, `Date: ${parsed.date}`, `Subject: ${parsed.subject}`, `To: ${parsed.to}`, '', parsed.body].join('\n');
      const subject = parsed.subject.startsWith('Fwd:') ? parsed.subject : `Fwd: ${parsed.subject}`;
      const raw = buildRawEmail({ to, cc, subject, body: forwardedBody, attachments: attachments as EmailAttachment[] | undefined });
      const result = await gmailPost<GmailMessage>('/users/me/messages/send', { raw });
      return {
        content: [{
          type: 'text',
          text: `Message forwarded!\nMessage ID: ${result.id}\nTo: ${to.join(', ')}` +
            (attachments?.length ? `\nExtra attachments: ${attachments.length} file(s) included` : '')
        }]
      };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
    }
  });

  server.registerTool('gmail_trash_message', {
    title: 'Move Gmail Message to Trash',
    description: `Move a Gmail message to Trash. Recoverable within 30 days. For permanent deletion use gmail_delete_message.`,
    inputSchema: { messageId: z.string().describe('Gmail message ID to move to trash') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  }, async ({ messageId }) => {
    try {
      await gmailPost<GmailMessage>(`/users/me/messages/${messageId}/trash`);
      return { content: [{ type: 'text', text: `Message ${messageId} moved to Trash.` }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
    }
  });

  server.registerTool('gmail_untrash_message', {
    title: 'Restore Gmail Message from Trash',
    description: `Restore a Gmail message from Trash back to Inbox.`,
    inputSchema: { messageId: z.string().describe('Gmail message ID to restore') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ messageId }) => {
    try {
      await gmailPost<GmailMessage>(`/users/me/messages/${messageId}/untrash`);
      return { content: [{ type: 'text', text: `Message ${messageId} restored from Trash.` }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
    }
  });

  server.registerTool('gmail_delete_message', {
    title: 'Permanently Delete Gmail Message',
    description: `PERMANENTLY delete a Gmail message. Irreversible. Use gmail_trash_message for recoverable deletion.`,
    inputSchema: { messageId: z.string().describe('Gmail message ID to permanently delete (IRREVERSIBLE)') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ messageId }) => {
    try {
      await gmailDelete(`/users/me/messages/${messageId}`);
      return { content: [{ type: 'text', text: `Message ${messageId} permanently deleted.` }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
    }
  });

  server.registerTool('gmail_modify_labels', {
    title: 'Modify Gmail Message Labels',
    description: `Add or remove labels on a Gmail message. System labels: INBOX, SENT, DRAFT, SPAM, TRASH, UNREAD, STARRED, IMPORTANT, CATEGORY_PERSONAL, CATEGORY_SOCIAL, CATEGORY_PROMOTIONS.`,
    inputSchema: {
      messageId: z.string().describe('Gmail message ID'),
      addLabelIds: z.array(z.string()).optional().describe('Label IDs to add'),
      removeLabelIds: z.array(z.string()).optional().describe('Label IDs to remove'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ messageId, addLabelIds, removeLabelIds }) => {
    try {
      const result = await gmailPost<GmailMessage>(`/users/me/messages/${messageId}/modify`, { addLabelIds: addLabelIds || [], removeLabelIds: removeLabelIds || [] });
      return { content: [{ type: 'text', text: `Labels updated for message ${messageId}.\nCurrent labels: ${(result.labelIds || []).join(', ')}` }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
    }
  });

  server.registerTool('gmail_mark_as_read', {
    title: 'Mark Gmail Message as Read',
    description: `Mark a Gmail message as read by removing the UNREAD label.`,
    inputSchema: { messageId: z.string().describe('Gmail message ID to mark as read') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ messageId }) => {
    try {
      await gmailPost<GmailMessage>(`/users/me/messages/${messageId}/modify`, { removeLabelIds: ['UNREAD'] });
      return { content: [{ type: 'text', text: `Message ${messageId} marked as read.` }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
    }
  });

  server.registerTool('gmail_mark_as_unread', {
    title: 'Mark Gmail Message as Unread',
    description: `Mark a Gmail message as unread by adding the UNREAD label.`,
    inputSchema: { messageId: z.string().describe('Gmail message ID to mark as unread') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ messageId }) => {
    try {
      await gmailPost<GmailMessage>(`/users/me/messages/${messageId}/modify`, { addLabelIds: ['UNREAD'] });
      return { content: [{ type: 'text', text: `Message ${messageId} marked as unread.` }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
    }
  });

  server.registerTool('gmail_star_message', {
    title: 'Star/Unstar Gmail Message',
    description: `Star or unstar a Gmail message.`,
    inputSchema: {
      messageId: z.string().describe('Gmail message ID'),
      starred: z.boolean().default(true).describe('true to star, false to unstar'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ messageId, starred }) => {
    try {
      await gmailPost<GmailMessage>(`/users/me/messages/${messageId}/modify`, { addLabelIds: starred ? ['STARRED'] : [], removeLabelIds: starred ? [] : ['STARRED'] });
      return { content: [{ type: 'text', text: `Message ${messageId} ${starred ? 'starred' : 'unstarred'}.` }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
    }
  });

  server.registerTool('gmail_batch_modify', {
    title: 'Batch Modify Gmail Messages',
    description: `Modify labels on multiple Gmail messages at once (up to 1000). More efficient than calling gmail_modify_labels repeatedly.`,
    inputSchema: {
      ids: z.array(z.string()).min(1).max(1000).describe('List of message IDs to modify'),
      addLabelIds: z.array(z.string()).optional().describe('Label IDs to add to all messages'),
      removeLabelIds: z.array(z.string()).optional().describe('Label IDs to remove from all messages'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ ids, addLabelIds, removeLabelIds }) => {
    try {
      await gmailPost('/users/me/messages/batchModify', { ids, addLabelIds: addLabelIds || [], removeLabelIds: removeLabelIds || [] });
      return { content: [{ type: 'text', text: `Batch modify applied to ${ids.length} message(s).\nAdded: ${(addLabelIds || []).join(', ') || 'none'}\nRemoved: ${(removeLabelIds || []).join(', ') || 'none'}` }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
    }
  });
}
