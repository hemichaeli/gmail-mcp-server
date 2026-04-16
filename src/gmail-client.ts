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
        'Missing required env vars: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN. ' +
        'Set them in Railway environment variables.'
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

export function handleGmailError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const axiosErr = error as AxiosError<{ error?: { message?: string; code?: number } }>;
    const gmailMsg = axiosErr.response?.data?.error?.message;
    const statusCode = axiosErr.response?.status;
    if (statusCode === 401) return 'Authentication failed. Refresh token may be expired - generate a new one.';
    if (statusCode === 403) return `Permission denied: ${gmailMsg || 'Check Gmail API scopes'}`;
    if (statusCode === 404) return `Not found: ${gmailMsg || 'Resource does not exist'}`;
    if (statusCode === 429) return 'Rate limit exceeded. Wait a moment and retry.';
    return `Gmail API error (${statusCode}): ${gmailMsg || axiosErr.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
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
}): string {
  const headers: string[] = [
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

  if (options.htmlBody) {
    const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    emailContent = [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(options.body).toString('base64'),
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(options.htmlBody).toString('base64'),
      '',
      `--${boundary}--`,
    ].join('\r\n');
  } else {
    emailContent = [
      ...headers,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(options.body).toString('base64'),
    ].join('\r\n');
  }

  return Buffer.from(emailContent)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ---- Parsing helpers ----

export function parseMessageHeaders(headers: Array<{ name: string; value: string }>): Record<string, string> {
  return headers.reduce((acc, h) => {
    acc[h.name.toLowerCase()] = h.value;
    return acc;
  }, {} as Record<string, string>);
}

export function decodeBase64(data: string): string {
  try {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
  } catch {
    return '[decode error]';
  }
}

export function extractBodyFromPart(part: MessagePart): { text: string; html: string } {
  let text = '';
  let html = '';

  function processPayload(p: MessagePart) {
    if (p.mimeType === 'text/plain' && p.body?.data) {
      text += decodeBase64(p.body.data);
    } else if (p.mimeType === 'text/html' && p.body?.data) {
      html += decodeBase64(p.body.data);
    }
    if (p.parts) {
      for (const subPart of p.parts) {
        processPayload(subPart);
      }
    }
  }

  processPayload(part);
  return { text, html };
}

export function parseFullMessage(msg: GmailMessage): ParsedMessage {
  const headers = msg.payload?.headers ? parseMessageHeaders(msg.payload.headers) : {};
  const { text, html } = msg.payload ? extractBodyFromPart(msg.payload) : { text: '', html: '' };

  return {
    id: msg.id,
    threadId: msg.threadId,
    from: headers['from'] || '',
    to: headers['to'] || '',
    cc: headers['cc'],
    bcc: headers['bcc'],
    subject: headers['subject'] || '(no subject)',
    date: msg.internalDate ? new Date(parseInt(msg.internalDate)).toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
    }) : headers['date'] || '',
    snippet: msg.snippet,
    body: text,
    htmlBody: html || undefined,
    labelIds: msg.labelIds || [],
    sizeEstimate: msg.sizeEstimate,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
