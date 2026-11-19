import { apiRequest } from "./api";

export interface MailboxAddress {
  id: string;
  address: string;
  label: string;
  createdAt: number;
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

export const mailboxApi = {
  addresses: () => apiRequest<{ enabled: boolean; addresses: MailboxAddress[] }>(route),
  create: (label: string, fetcher?: typeof fetch) =>
    apiRequest<{ address: MailboxAddress }>(route, "POST", { label }, fetcher),
  remove: (id: string) => apiRequest<void>(`${route}/${encodeURIComponent(id)}`, "DELETE"),
  messages: (addressId: string) =>
    apiRequest<{ messages: MailboxMessage[] }>(messagesRoute(addressId)),
  message: (addressId: string, messageId: string) =>
    apiRequest<{ message: MailboxContents }>(
      `${messagesRoute(addressId)}/${encodeURIComponent(messageId)}`,
    ),
};
