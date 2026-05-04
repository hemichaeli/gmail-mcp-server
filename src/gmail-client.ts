import axios, { AxiosError } from 'axios';
import { OAuth2Client } from 'google-auth-library';
import { GmailMessage, MessagePart, ParsedMessage } from './types';

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';

let oauth2Client: OAuth2Client | null = null;

function getOAuth2Client(): OAuth2Client {
  if (!oauth2Client) {
    const clientId = process.env.GMAIL_CLIENT_ID;
    const clientSecret = process.env.GMAIL_CLIENT_SECRET;
    const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(
        'Missing required env vars: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN.'
      );
    }

    oauth2Client = new OAuth2Client(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
  }
  return oauth2Client;
}

export async function getAccessToken(): Promise<string> {
  const client = getOAuth2Client();
  const tokenResponse = await client.getAccessToken();
  if (!tokenResponse.token) {
    throw new Error('Failed to get access token. Check that GMAIL_REFRESH_TOKEN is valid.');
  }
  return tokenResponse.token;
}

export async function gmailGet<T>(endpoint: string, params?: Record<string, unknown>): Promise<T> {
  const token = await getAccessToken();
  const response = await axios.get<T>(`${GMAIL_API_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
    params
  });
  return response.data;
}

export async function gmailPost<T>(endpoint: string, data?: unknown, params?: Record<string, unknown>): Promise<T> {
  const token = await getAccessToken();
  const response = await axios.post<T>(`${GMAIL_API_BASE}${endpoint}`, data, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    params
  });
  return response.data;
}

export async function gmailPut<T>(endpoint: string, data?: unknown): Promise<T> {
  const token = await getAccessToken();
  const response = await axios.put<T>(`${GMAIL_API_BASE}${endpoint}`, data, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  return response.data;
}

export async function gmailPatch<T>(endpoint: string, data?: unknown): Promise<T> {
  const token = await getAccessToken();
  const response = await axios.patch<T>(`${GMAIL_API_BASE}${endpoint}`, data, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  return response.data;
}

export async function gmailDelete(endpoint: string): Promise<void> {
  const token = await getAccessToken();
  await axios.delete(`${GMAIL_API_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
}

// Download an attachment from Gmail and return it as base64
export async function gmailGetAttachment(messageId: string, attachmentId: string): Promise<string> {
  const token = await getAccessToken();
  const response = await axios.get<{ size: number; data: string }>(
    `${GMAIL_API_BASE}/users/me/messages/${messageId}/attachments/${attachmentId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return response.data.data; // base64url encoded
}

export function handleGmailError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const axiosErr = error as AxiosError<{ error?: { message?: string; code?: number } }>;
    const gmailMsg = axiosErr.response?.data?.error?.message;
    const statusCode = axiosErr.response?.status;
    if (statusCode === 401) return 'Authentication failed. Refresh token may be expired.';
    if (statusCode === 403) return `Permission denied: ${gmailMsg || 'Check Gmail API scopes'}`;
    if (statusCode === 404) return `Not found: ${gmailMsg || 'Resource does not exist'}`;
    if (statusCode === 429) return 'Rate limit exceeded. Wait a moment and retry.';
    return `Gmail API error (${statusCode}): ${gmailMsg || axiosErr.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---- Attachment type ----

export interface EmailAttachment {
  filename: string;         // e.g. "report.pdf"
  mimeType: string;         // e.g. "application/pdf"
  data: string;             // base64-encoded file content (standard or url-safe)
}

// ---- Email building ----

export function buildRawEmail(options: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  htmlBody?: string;
  from?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: EmailAttachment[];
}): string {
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const hasAttachments = options.attachments && options.attachments.length > 0;

  const headerLines: string[] = [
    ...(options.from ? [`From: ${options.from}`] : []),
    `To: ${options.to.join(', ')}`,
    ...(options.cc?.length ? [`Cc: ${options.cc.join(', ')}`] : []),
    ...(options.bcc?.length ? [`Bcc: ${options.bcc.join(', ')}`] : []),
    `Subject: =?UTF-8?B?${Buffer.from(options.subject).toString('base64')}?=`,
    ...(options.inReplyTo ? [`In-Reply-To: ${options.inReplyTo}`] : []),
    ...(options.references ? [`References: ${options.references}`] : []),
    'MIME-Version: 1.0',
  ];

  let emailContent: string;

  if (hasAttachments) {
    // multipart/mixed wraps body + attachments
    const innerBoundary = `inner_${boundary}`;

    const bodyPart = options.htmlBody
      ? [
          `--${innerBoundary}`,
          'Content-Type: text/plain; charset=UTF-8',
          'Content-Transfer-Encoding: base64',
          '',
          Buffer.from(options.body).toString('base64'),
          '',
          `--${innerBoundary}`,
          'Content-Type: text/html; charset=UTF-8',
          'Content-Transfer-Encoding: base64',
          '',
          Buffer.from(options.htmlBody).toString('base64'),
          '',
          `--${innerBoundary}--`,
        ].join('\r\n')
      : [
          `--${innerBoundary}`,
          'Content-Type: text/plain; charset=UTF-8',
          'Content-Transfer-Encoding: base64',
          '',
          Buffer.from(options.body).toString('base64'),
          '',
          `--${innerBoundary}--`,
        ].join('\r\n');

    const bodySection = options.htmlBody
      ? [`Content-Type: multipart/alternative; boundary="${innerBoundary}"`, '', bodyPart].join('\r\n')
      : bodyPart;

    const attachmentParts = options.attachments!.map(att => {
      // normalize base64url to standard base64
      const b64 = att.data.replace(/-/g, '+').replace