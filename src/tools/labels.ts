import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
import {
  gmailGet, gmailPost, gmailPatch, gmailDelete,
  handleGmailError
} from '../gmail-client';
import { GmailLabel } from '../types';

interface ListLabelsResponse {
  labels?: GmailLabel[];
}

export function registerLabelTools(server: McpServer): void {

  server.registerTool(
    'gmail_list_labels',
    {
      title: 'List Gmail Labels',
      description: `List all Gmail labels (system and user-created).

System labels include: INBOX, SENT, DRAFTS, SPAM, TRASH, UNREAD, STARRED, IMPORTANT,
CATEGORY_PERSONAL, CATEGORY_SOCIAL, CATEGORY_PROMOTIONS, CATEGORY_UPDATES, CATEGORY_FORUMS.

User labels have auto-generated IDs like "Label_123456789".
Returns label IDs, names, and message/thread counts.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async () => {
      try {
        const data = await gmailGet<ListLabelsResponse>('/users/me/labels');
        const labels = data.labels || [];

        const systemLabels = labels.filter(l => l.type === 'system');
        const userLabels = labels.filter(l => l.type === 'user');

        const text = [
          `Total labels: ${labels.length} (${systemLabels.length} system, ${userLabels.length} user-created)\n`,
          `SYSTEM LABELS:`,
          ...systemLabels.map(l => `  ${l.id.padEnd(30)} ${l.name}`),
          ``,
          `USER LABELS:`,
          ...(userLabels.length === 0
            ? ['  (none)']
            : userLabels.map(l =>
              `  ${l.id.padEnd(30)} ${l.name}` +
              (l.messagesUnread ? ` [${l.messagesUnread} unread]` : '')
            )),
        ].join('\n');

        return { content: [{ type: 'text', text }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
      }
    }
  );

  server.registerTool(
    'gmail_get_label',
    {
      title: 'Get Gmail Label Details',
      description: `Get detailed information about a specific Gmail label including message and thread counts.`,
      inputSchema: {
        labelId: z.string().describe('Gmail label ID, e.g. "INBOX" or "Label_123456789"'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ labelId }) => {
      try {
        const label = await gmailGet<GmailLabel>(`/users/me/labels/${labelId}`);

        const text = [
          `Label: ${label.name}`,
          `ID: ${label.id}`,
          `Type: ${label.type || 'user'}`,
          `Message visibility: ${label.messageListVisibility || 'show'}`,
          `Label visibility: ${label.labelListVisibility || 'labelShow'}`,
          ...(label.messagesTotal !== undefined ? [`Messages: ${label.messagesTotal} total, ${label.messagesUnread || 0} unread`] : []),
          ...(label.threadsTotal !== undefined ? [`Threads: ${label.threadsTotal} total, ${label.threadsUnread || 0} unread`] : []),
          ...(label.color ? [`Color: text=${label.color.textColor}, bg=${label.color.backgroundColor}`] : []),
        ].join('\n');

        return { content: [{ type: 'text', text }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
      }
    }
  );

  server.registerTool(
    'gmail_create_label',
    {
      title: 'Create Gmail Label',
      description: `Create a new Gmail label (folder/tag) with optional color.

Args:
  - name: label display name (required, max 225 chars)
  - messageListVisibility: "show" or "hide" (default: "show")
  - labelListVisibility: "labelShow", "labelShowIfUnread", or "labelHide" (default: "labelShow")
  - textColor: text color hex code, e.g. "#000000"
  - backgroundColor: background color hex code, e.g. "#4a86e8"`,
      inputSchema: {
        name: z.string().min(1).max(225).describe('Label name (max 225 characters)'),
        messageListVisibility: z.enum(['show', 'hide']).default('show')
          .describe('Whether messages with this label appear in message list'),
        labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).default('labelShow')
          .describe('Label visibility in the labels list'),
        textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()
          .describe('Text color hex code, e.g. "#000000"'),
        backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()
          .describe('Background color hex code, e.g. "#4a86e8"'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async ({ name, messageListVisibility, labelListVisibility, textColor, backgroundColor }) => {
      try {
        const body: Record<string, unknown> = { name, messageListVisibility, labelListVisibility };
        if (textColor || backgroundColor) {
          body['color'] = {
            ...(textColor ? { textColor } : {}),
            ...(backgroundColor ? { backgroundColor } : {}),
          };
        }

        const label = await gmailPost<GmailLabel>('/users/me/labels', body);

        return {
          content: [{
            type: 'text',
            text: `Label created!\nName: ${label.name}\nID: ${label.id}`
          }]
        };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
      }
    }
  );

  server.registerTool(
    'gmail_update_label',
    {
      title: 'Update Gmail Label',
      description: `Update an existing Gmail label name, visibility, or color. All fields are optional.`,
      inputSchema: {
        labelId: z.string().describe('Gmail label ID to update'),
        name: z.string().min(1).max(225).optional().describe('New label name'),
        messageListVisibility: z.enum(['show', 'hide']).optional().describe('Message list visibility'),
        labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe('Label list visibility'),
        textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Text color hex code'),
        backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Background color hex code'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ labelId, name, messageListVisibility, labelListVisibility, textColor, backgroundColor }) => {
      try {
        const body: Record<string, unknown> = { id: labelId };
        if (name) body['name'] = name;
        if (messageListVisibility) body['messageListVisibility'] = messageListVisibility;
        if (labelListVisibility) body['labelListVisibility'] = labelListVisibility;
        if (textColor || backgroundColor) {
          body['color'] = {
            ...(textColor ? { textColor } : {}),
            ...(backgroundColor ? { backgroundColor } : {}),
          };
        }

        const label = await gmailPatch<GmailLabel>(`/users/me/labels/${labelId}`, body);

        return {
          content: [{
            type: 'text',
            text: `Label updated!\nName: ${label.name}\nID: ${label.id}`
          }]
        };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
      }
    }
  );

  server.registerTool(
    'gmail_delete_label',
    {
      title: 'Delete Gmail Label',
      description: `Delete a Gmail user label. System labels cannot be deleted.
Messages with this label are not deleted - only the label is removed from them.`,
      inputSchema: {
        labelId: z.string().describe('Gmail label ID to delete (user labels only, not system labels)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async ({ labelId }) => {
      try {
        await gmailDelete(`/users/me/labels/${labelId}`);
        return { content: [{ type: 'text', text: `Label ${labelId} deleted. Messages with this label are not affected.` }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${handleGmailError(error)}` }] };
      }
    }
  );
}
