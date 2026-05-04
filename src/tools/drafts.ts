import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gmailGet, gmailPost, gmailPut, gmailDelete, buildRawEmail, parseFullMessage, handleGmailError, EmailAttachment } from '../gmail-client.js';
import { GmailDraft, GmailMessage } from '../types.js';

interface ListDraftsResponse {
  drafts?: Array<{ id: string; message?: { id: string; threadId: string } }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

const attachmentSchema = z.array(z.object({
  filename: z.string().describe('Filename including extension, e.g. "report.pdf"'),
  mimeType: z.string().describe('MIME type, e.g. "application/pdf", "image/png", "text/csv"'),
  data: z.string().describe('Base64-encoded file content (standard or URL-safe base64)'),
})).optional().describe('File attachments. Each requires filename, mimeType, and base64-encoded data.');

export function registerDraftTools(server: McpServer): void {

  server.registerTool('gmail_list_drafts', {
    title: 'List Gmail Drafts',
    description: `List all Gmail draft messages. Returns draft IDs and metadata. Use gmail_get_draft to fetch full content.`,
    inputSchema: {
      maxResults: z.number().int().min(1).max(500).default(20).describe('Number of drafts to return'),
      pageToken: z.string().optional().describe('Pagination token'),
      query: z.string().optional().describe('Filter by Gmail search query'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ maxResults, pageToken, query }) => {
    try {
      const params: Record<string, unknown> = { maxResults };
      if (pageToken) params['pageToken'] = pageToken;
      if (query) params['q'] = query;
      const data = await gmailGet<ListDraftsResponse>('/users/me/drafts', params);
      const drafts = data.drafts || [];
      const text = drafts.length === 0
        ? 'No drafts found.'
        : `Found ${drafts.length} draft(s).${data.nextPageToken ? ` Next page token: "${data.nextPageToken}"` : ''}\n\n` +
          drafts.map((d, i) => `${i + 1}. Draft ID: ${d.id}${d.message ? ` | Message ID: ${d.message.id}` : ''}`).join('\n');
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
    }
  });

  server.registerTool('gmail_get_draft', {
    title: 'Get Gmail Draft',
    description: `Fetch the full content of a Gmail draft by ID, including decoded body and attachment list.`,
    inputSchema: {
      draftId: z.string().describe('Gmail draft ID'),
      format: z.enum(['full', 'minimal', 'raw']).default('full').describe('Response format'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ draftId, format }) => {
    try {
      const data = await gmailGet<GmailDraft>(`/users/me/drafts/${draftId}`, { format });
      const msg = data.message;
      if (!msg) return { content: [{ type: 'text', text: `Draft ${draftId} has no message content.` }] };
      if (format === 'full' && msg.payload) {
        const parsed = parseFullMessage(msg);
        const attLines = parsed.attachments.length > 0
          ? [``, `--- ATTACHMENTS (${parsed.attachments.length}) ---`,
             ...parsed.attachments.map((a, i) => `  ${i + 1}. ${a.filename} (${a.mimeType}) | attachmentId: ${a.attachmentId}`)]
          : [];
        const text = [
          `Draft ID: ${draftId}`, `From: ${parsed.from}`, `To: ${parsed.to}`,
          ...(parsed.cc ? [`Cc: ${parsed.cc}`] : []),
          `Subject: ${parsed.subject}`, `Date: ${parsed.date}`,
          ``, `--- BODY ---`, parsed.body || msg.snippet || '(no body)',
          ...attLines,
        ].join('\n');
        return { content: [{ type: 'text', text }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ draftId, message: msg }, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
    }
  });

  server.registerTool('gmail_create_draft', {
    title: 'Create Gmail Draft',
    description: `Create a new Gmail draft message with optional file attachments.

Supports plain text and HTML bodies, CC, BCC, and file attachments.
Attachments: provide filename, mimeType, and base64-encoded data.

Common mimeTypes: application/pdf, image/png, image/jpeg, text/csv,
application/vnd.openxmlformats-officedocument.spreadsheetml.sheet (xlsx),
application/vnd.openxmlformats-officedocument.wordprocessingml.document (docx)`,
    inputSchema: {
      to: z.array(z.string().email()).min(1).describe('Recipient email addresses'),
      subject: z.string().describe('Email subject line'),
      body: z.string().describe('Plain text body'),
      htmlBody: z.string().optional().describe('HTML body (optional)'),
      cc: z.array(z.string().email()).optional().describe('CC recipients'),
      bcc: z.array(z.string().email()).optional().describe('BCC recipients'),
      threadId: z.string().optional().describe('Thread ID to associate this draft with'),
      attachments: attachmentSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async ({ to, subject, body, htmlBody, cc, bcc, threadId, attachments }) => {
    try {
      const raw = buildRawEmail({ to, subject, body, htmlBody, cc, bcc, attachments: attachments as EmailAttachment[] | undefined });
      const message: Record<string, string> = { raw };
      if (threadId) message['threadId'] = threadId;
      const result = await gmailPost<GmailDraft>('/users/me/drafts', { message });
      return {
        content: [{
          type: 'text',
          text: `Draft created!\nDraft ID: ${result.id}\nMessage ID: ${result.message?.id || 'N/A'}` +
            (attachments?.length ? `\nAttachments: ${attachments.length} file(s) included` : '')
        }]
      };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
    }
  });

  server.registerTool('gmail_update_draft', {
    title: 'Update Gmail Draft',
    description: `Update an existing Gmail draft. Replaces the entire draft content including attachments.`,
    inputSchema: {
      draftId: z.string().describe('Gmail draft ID to update'),
      to: z.array(z.string().email()).min(1).describe('Recipient email addresses'),
      subject: z.string().describe('Email subject line'),
      body: z.string().describe('Plain text body'),
      htmlBody: z.string().optional().describe('HTML body (optional)'),
      cc: z.array(z.string().email()).optional().describe('CC recipients'),
      bcc: z.array(z.string().email()).optional().describe('BCC recipients'),
      attachments: attachmentSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async ({ draftId, to, subject, body, htmlBody, cc, bcc, attachments }) => {
    try {
      const raw = buildRawEmail({ to, subject, body, htmlBody, cc, bcc, attachments: attachments as EmailAttachment[] | undefined });
      const result = await gmailPut<GmailDraft>(`/users/me/drafts/${draftId}`, { message: { raw } });
      return {
        content: [{
          type: 'text',
          text: `Draft ${draftId} updated.\nMessage ID: ${result.message?.id || 'N/A'}` +
            (attachments?.length ? `\nAttachments: ${attachments.length} file(s) included` : '')
        }]
      };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
    }
  });

  server.registerTool('gmail_send_draft', {
    title: 'Send Gmail Draft',
    description: `Send an existing Gmail draft. The draft is deleted after sending.`,
    inputSchema: { draftId: z.string().describe('Gmail draft ID to send') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async ({ draftId }) => {
    try {
      const result = await gmailPost<GmailMessage>('/users/me/drafts/send', { id: draftId });
      return { content: [{ type: 'text', text: `Draft sent!\nMessage ID: ${result.id}\nThread ID: ${result.threadId}` }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
    }
  });

  server.registerTool('gmail_delete_draft', {
    title: 'Delete Gmail Draft',
    description: `Permanently delete a Gmail draft. Cannot be undone.`,
    inputSchema: { draftId: z.string().describe('Gmail draft ID to permanently delete') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ draftId }) => {
    try {
      await gmailDelete(`/users/me/drafts/${draftId}`);
      return { content: [{ type: 'text', text: `Draft ${draftId} deleted.` }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
    }
  });
}
