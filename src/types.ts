export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: MessagePart;
  raw?: string;
}

export interface MessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Header[];
  body?: MessagePartBody;
  parts?: MessagePart[];
}

export interface MessagePartBody {
  attachmentId?: string;
  size?: number;
  data?: string;
}

export interface Header {
  name: string;
  value: string;
}

export interface GmailThread {
  id: string;
  historyId?: string;
  messages?: GmailMessage[];
  snippet?: string;
}

export interface GmailLabel {
  id: string;
  name: string;
  type?: string;
  messageListVisibility?: string;
  labelListVisibility?: string;
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
  color?: {
    textColor: string;
    backgroundColor: string;
  };
}

export interface GmailDraft {
  id: string;
  message?: GmailMessage;
}

export interface GmailFilter {
  id: string;
  criteria?: FilterCriteria;
  action?: FilterAction;
}

export interface FilterCriteria {
  from?: string;
  to?: string;
  subject?: string;
  query?: string;
  negatedQuery?: string;
  hasAttachment?: boolean;
  excludeChats?: boolean;
  size?: number;
  sizeComparison?: string;
}

export interface FilterAction {
  addLabelIds?: string[];
  removeLabelIds?: string[];
  forward?: string;
}

export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}

export interface ParsedMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  date: string;
  snippet?: string;
  body: string;
  htmlBody?: string;
  labelIds: string[];
  sizeEstimate?: number;
}
