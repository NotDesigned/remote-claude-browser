export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  files?: { id: string; name: string }[];
  /** Thinking/process rows shown above the answer; `text` exists only while expanded remotely. */
  steps?: { summary: string; text?: string; state: string }[];
}

export interface ChatState {
  tab: string;
  epoch: string;
  url: string;
  title: string;
  ready: boolean;
  draft?: string;
  generating: boolean;
  messages: ChatMessage[];
  conversations: { path: string; title: string }[];
}

export interface TextEdit {
  at: number;
  delete: number;
  insert: string;
}

/** UTF-16 offsets deliberately match JavaScript String.slice on both ends. */
export function textEdit(before: string, after: string): TextEdit {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - end - 1] === after[after.length - end - 1]
  )
    end++;
  return {
    at: start,
    delete: before.length - start - end,
    insert: after.slice(start, after.length - end),
  };
}

export function chatDelta(
  before: ChatState | undefined,
  after: ChatState,
): Record<string, unknown> | null {
  if (!before || before.epoch !== after.epoch) return { type: "snapshot", state: after };
  const edits = after.messages.flatMap<{ index: number; message?: ChatMessage; edit?: TextEdit }>(
    (message, index) => {
      const previous = before.messages[index];
      if (
        !previous ||
        previous.id !== message.id ||
        previous.role !== message.role ||
        JSON.stringify(previous.files) !== JSON.stringify(message.files) ||
        JSON.stringify(previous.steps) !== JSON.stringify(message.steps)
      ) {
        return [{ index, message }];
      }
      if (previous.text === message.text) return [];
      return [{ index, edit: textEdit(previous.text, message.text) }];
    },
  );
  const metadata = {
    url: after.url,
    title: after.title,
    ready: after.ready,
    draft: after.draft,
    generating: after.generating,
    conversations: after.conversations,
  };
  const prior = {
    url: before.url,
    title: before.title,
    ready: before.ready,
    draft: before.draft,
    generating: before.generating,
    conversations: before.conversations,
  };
  if (
    !edits.length &&
    before.messages.length === after.messages.length &&
    JSON.stringify(metadata) === JSON.stringify(prior)
  )
    return null;
  const { conversations, ...fields } = metadata;
  return {
    type: "delta",
    epoch: after.epoch,
    edits,
    length: after.messages.length,
    ...fields,
    ...(JSON.stringify(before.conversations) === JSON.stringify(conversations)
      ? {}
      : { conversations }),
  };
}
