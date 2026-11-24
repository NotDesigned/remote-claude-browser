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
  domains?: string[];
  canClaim?: boolean;
  pendingClaim?: string;
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
  create: (
    details: { label: string; localPart?: string; domain?: string },
    fetcher?: typeof fetch,
  ) => apiRequest<{ address: MailboxAddress }>(route, "POST", details, fetcher),
  startClaim: (address: string) =>
    apiRequest<{ address: string }>(`${route}/claims`, "POST", { address }),
  confirmClaim: (address: string, code: string) =>
    apiRequest<{ address: MailboxAddress }>(`${route}/claims/confirm`, "POST", { address, code }),
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
