import { setTimeout as pause } from "node:timers/promises";
import { untilCanceled } from "./account-onboarding-attempts";

interface MessageSummary {
  id: string;
  from: string;
  subject: string;
  receivedAt: number;
}

interface Message extends MessageSummary {
  text: string;
  html?: string;
  authenticated: boolean;
}

export interface OnboardingMailbox {
  readonly enabled: boolean;
  getAddress(owner: string, mailboxId: string): { id: string; address: string } | undefined;
  listAddresses?(owner: string): { id: string; address: string }[];
  listMessages(owner: string, mailboxId: string, since?: number): MessageSummary[];
  readMessage(owner: string, mailboxId: string, messageId: string): Promise<Message | undefined>;
}

type Provider = "apple" | "claude";
export type AppleCodeAction = "filled" | "submitted";
interface Tab {
  sid: string;
  tab: string;
}
interface Verification extends Tab {
  provider: Provider;
  owner: string;
  mailboxId: string;
  email: string;
  since: number;
  signal?: AbortSignal;
  isActive(): boolean;
  apply?(code: string): Promise<AppleCodeAction | undefined>;
}

const WAIT_MS = 10 * 60_000;
const POLL_MS = 1_500;
const senderDomain = {
  apple: /@(?:[\w-]+\.)*apple\.com$/i,
  claude: /@mail\.anthropic\.com$/i,
};
const mailSubject = {
  apple: /verif(?:y|ication).*(?:e-?mail|code|apple (?:id|account))/i,
  claude: /^secure link to log in to claude\.ai$/i,
};

export const isAppleRelayEmail = (address: string) =>
  /^[a-z0-9._%+~-]+@(?:privaterelay\.appleid\.com|private\.icloud\.com)$/i.test(address);

function isVerificationMail({ provider, email }: Verification, mail: MessageSummary) {
  const from = mail.from.trim();
  const address = /<([^<>]+)>$/.exec(from)?.[1] ?? from;
  return (
    mailSubject[provider].test(mail.subject.trim()) &&
    (senderDomain[provider].test(address) ||
      (provider === "claude" && isAppleRelayEmail(email) && isAppleRelayEmail(address)))
  );
}

function appleCode(mail: Message): string | undefined {
  const text = mail.text || mail.html?.replace(/<[^>]*>/g, " ") || "";
  const codes = new Set(text.match(/\b\d{6}\b/g));
  if (codes.size === 1) return codes.values().next().value;
}

function claudeLink(mail: Message, email: string) {
  const body = `${mail.text}\n${mail.html ?? ""}`.replace(/&(?:amp|#38|#x26);/gi, "&");
  const links = body.match(/https:\/\/[^\s<>"']+/g) ?? [];
  for (const link of links) {
    const match = /^https:\/\/claude\.ai\/magic-link#([\da-fA-F]{32}):([\w+/=-]+)$/.exec(link);
    if (!match) continue;
    const token = match[1]!;
    const encodedEmail = match[2]!;
    if (Buffer.from(encodedEmail, "base64").toString().toLowerCase() !== email.toLowerCase())
      continue;
    // Reconstruct the official URL from the validated token and address.
    return `https://claude.ai/magic-link#${token}:${encodedEmail}`;
  }
}

interface Watcher extends Verification {
  seen: Set<string>;
  pending?: string;
  ready: boolean;
  submitted?: boolean;
  opening: boolean;
  latest: number;
}

export function createVerification(mailbox?: OnboardingMailbox) {
  const jobs = new Map<string, Watcher>();
  const shutdown = new AbortController();
  const keyOf = (provider: Provider, { sid, tab }: Tab) => JSON.stringify([provider, sid, tab]);
  const active = (key: string, job: Watcher) =>
    jobs.get(key) === job &&
    !job.signal?.aborted &&
    Date.now() < job.since + WAIT_MS &&
    job.isActive() &&
    !!mailbox?.getAddress(job.owner, job.mailboxId);

  async function poll(box: OnboardingMailbox, key: string, job: Watcher) {
    const signal = job.signal ? AbortSignal.any([job.signal, shutdown.signal]) : shutdown.signal;
    try {
      while (active(key, job)) {
        try {
          if (!job.ready || (job.provider === "claude" && !job.apply)) {
            const messages = box
              .listMessages(job.owner, job.mailboxId, job.since)
              .filter(
                (mail) =>
                  mail.receivedAt >= job.since &&
                  mail.receivedAt > job.latest &&
                  !job.seen.has(mail.id) &&
                  isVerificationMail(job, mail),
              )
              .sort((a, b) => b.receivedAt - a.receivedAt);
            for (const { id } of messages) {
              const mail = await untilCanceled(job.signal, () =>
                box.readMessage(job.owner, job.mailboxId, id),
              );
              if (!active(key, job)) return;
              job.seen.add(id);
              if (!mail?.authenticated || !isVerificationMail(job, mail)) continue;
              const value =
                job.provider === "apple" ? appleCode(mail) : claudeLink(mail, job.email);
              if (!value) continue;
              job.pending = value;
              job.latest = mail.receivedAt;
              if (job.provider === "claude" && !job.apply) job.ready = true;
              break;
            }
            const code = job.pending;
            if (code && job.apply) {
              const action = await untilCanceled(job.signal, () => job.apply!(code));
              if (action) {
                job.ready = true;
                job.submitted = action === "submitted";
                job.pending = undefined;
              }
            }
          }
        } catch {
          // Receiving email or switching browser pages can briefly interrupt a poll.
        }
        await pause(POLL_MS, undefined, { ref: false, signal });
      }
    } finally {
      if (jobs.get(key) === job) jobs.delete(key);
    }
  }
  function forOwner(provider: Provider, tab: Tab, owner: string | undefined) {
    const key = keyOf(provider, tab);
    const job = jobs.get(key);
    if (job && job.owner === owner && active(key, job)) return job;
  }
  return {
    start(input: Verification) {
      if (!mailbox) return;
      const key = keyOf(input.provider, input);
      const job = {
        ...input,
        seen: new Set<string>(),
        ready: false,
        opening: false,
        latest: -Infinity,
      };
      jobs.set(key, job);
      void poll(mailbox, key, job).catch(() => undefined);
    },
    status(provider: Provider, tab: Tab, owner: string | undefined) {
      const job = forOwner(provider, tab, owner);
      return {
        ready: job?.ready ?? false,
        expired: !job,
        ...(job?.pending && (provider === "apple" || job.apply) && { received: true }),
        ...(job?.submitted && { submitted: true }),
      };
    },
    async open(tab: Tab, owner: string | undefined, navigate: (url: string) => Promise<boolean>) {
      const job = forOwner("claude", tab, owner);
      if (!job?.pending || job.opening) return false;
      job.opening = true;
      try {
        if (!(await navigate(job.pending))) return false;
        const key = keyOf("claude", tab);
        if (jobs.get(key) === job) jobs.delete(key);
        return true;
      } finally {
        job.opening = false;
      }
    },
    close() {
      jobs.clear();
      shutdown.abort();
    },
  };
}
