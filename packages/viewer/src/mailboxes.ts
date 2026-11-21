import { apiRequest } from "./api";

export interface MailboxAddress {
  id: string;
  address: string;
  label: string;
  createdAt: number;
}

interface MailboxAddresses {
  enabled: boolean;
  addresses: MailboxAddress[];
  domain?: string;
}

export interface MailboxMessage {
  id: string;
  from: string;
  subject: string;
  receivedAt: number;
}

export interface MailboxContents extends MailboxMessage {
  text: string;
}

export function mailboxLabel(address: MailboxAddress): string {
  return address.label ? `${address.label} · ${address.address}` : address.address;
}

const route = "/api/me/mailboxes";
const messagesRoute = (addressId: string) => `${route}/${encodeURIComponent(addressId)}/messages`;
const userMailboxesRoute = (userId: string) => `/api/users/${encodeURIComponent(userId)}/mailboxes`;

export const mailboxApi = {
  addresses: () => apiRequest<MailboxAddresses>(route),
  create: (details: { label: string; localPart?: string }, fetcher?: typeof fetch) =>
    apiRequest<{ address: MailboxAddress }>(route, "POST", details, fetcher),
  remove: (id: string) => apiRequest<void>(`${route}/${encodeURIComponent(id)}`, "DELETE"),
  messages: (addressId: string) =>
    apiRequest<{ messages: MailboxMessage[] }>(messagesRoute(addressId)),
  message: (addressId: string, messageId: string) =>
    apiRequest<{ message: MailboxContents }>(
      `${messagesRoute(addressId)}/${encodeURIComponent(messageId)}`,
    ),
};

export const adminMailboxApi = {
  addresses: (userId: string) => apiRequest<MailboxAddresses>(userMailboxesRoute(userId)),
  assign: (userId: string, address: string) =>
    apiRequest<{ address: MailboxAddress }>(userMailboxesRoute(userId), "POST", { address }),
};
