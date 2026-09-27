/**
 * Web adapter for chat-sdk.
 *
 * Speaks the AI SDK UI message stream protocol so a chat-sdk bot can serve
 * a browser UI alongside Slack/Teams/Discord. The browser POSTs the
 * conversation, the user handler runs on the server, and its output streams
 * back in the same response body.
 */

import {
  cardToFallbackText,
  extractCard,
  ValidationError,
} from "@chat-adapter/shared";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  isTextUIPart,
  type UIMessage,
} from "ai";
import {
  type Adapter,
  type AdapterPostableMessage,
  type Author,
  type CardElement,
  type ChatInstance,
  ConsoleLogger,
  type EmojiValue,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  type Logger,
  Message,
  NotImplementedError,
  parseMarkdown,
  type RawMessage,
  type StreamChunk,
  type StreamOptions,
  type ThreadInfo,
  type UserInfo,
} from "chat";
import { requireWebRequestContext, webRequestContext } from "./als";
import {
  ACTION_PART_TYPE,
  CARD_PART_TYPE,
  readActionPart,
  readCardPart,
  type WebCardAction,
  type WebCardData,
} from "./card-part";
import { WebFormatConverter } from "./format-converter";
import { cardOffersAction, sealCard, verifyCardSeal } from "./seal";
import type { WebAdapterConfig, WebUser } from "./types";

/** Decoded thread id components for the Web adapter. */
export interface WebThreadIdData {
  conversationId: string;
  userId: string;
}

const ADAPTER_NAME = "web";

/** Default thread id derivation: `web:{userId}:{conversationId}`. */
const defaultThreadIdFor = (args: {
  user: WebUser;
  conversationId: string;
}): string => `${ADAPTER_NAME}:${args.user.id}:${args.conversationId}`;

interface WebRequestBody {
  /** Optional useChat-supplied conversation id. Generated if absent. */
  id?: string;
  /** Latest UIMessage[] history sent by useChat. */
  messages: UIMessage[];
}

export class WebAdapter implements Adapter<WebThreadIdData, UIMessage> {
  readonly name = ADAPTER_NAME;
  readonly userName: string;
  readonly persistMessageHistory: boolean;
  readonly lockScope = "thread" as const;

  protected chat: ChatInstance | null = null;
  protected readonly logger: Logger;
  protected readonly formatConverter = new WebFormatConverter();
  protected readonly resolveUser: WebAdapterConfig["getUser"];
  protected readonly threadIdFor: NonNullable<WebAdapterConfig["threadIdFor"]>;
  protected readonly actionSecret: string | undefined;

  constructor(opts: WebAdapterConfig) {
    if (!opts.userName) {
      throw new ValidationError(ADAPTER_NAME, "userName is required");
    }
    if (typeof opts.getUser !== "function") {
      throw new ValidationError(
        ADAPTER_NAME,
        "getUser is required — supply a function that resolves the user from the inbound Request"
      );
    }
    if (opts.actionSecret !== undefined && !opts.actionSecret) {
      throw new ValidationError(
        ADAPTER_NAME,
        "actionSecret must be a non-empty string when provided"
      );
    }
    this.userName = opts.userName;
    this.resolveUser = opts.getUser;
    this.actionSecret = opts.actionSecret;
    this.threadIdFor = opts.threadIdFor ?? defaultThreadIdFor;
    // Default true: with no platform-side message API, the only way for
    // chat-sdk handlers to see prior turns (via thread/channel.messages) is
    // through the configured state adapter. The request body's `messages[]`
    // is not an alternative source — it is client-controlled and ignored
    // beyond the latest user message — so opting out leaves handlers with
    // only the current message.
    this.persistMessageHistory = opts.persistMessageHistory ?? true;
    this.logger = opts.logger ?? new ConsoleLogger("info", "chat-adapter-web");
  }

  initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    return Promise.resolve();
  }

  async handleWebhook(request: Request): Promise<Response> {
    if (!this.chat) {
      return jsonError(500, "Web adapter not initialized");
    }

    let body: WebRequestBody;
    try {
      body = (await request.json()) as WebRequestBody;
    } catch {
      return jsonError(400, "Invalid JSON body");
    }

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return jsonError(400, "Request body must include a messages array");
    }

    let user: WebUser | null;
    try {
      user = await this.resolveUser(request);
    } catch (err) {
      this.logger.error("getUser threw", { error: err });
      return jsonError(401, "Unauthorized");
    }
    if (!user) {
      return jsonError(401, "Unauthorized");
    }
    if (user.id.includes(":")) {
      // Thread ids embed the user id between `:` delimiters
      // (`web:{userId}:{conversationId}`); a colon in the userId would
      // corrupt the round-trip through decodeThreadId.
      this.logger.error("getUser returned id with reserved ':' character", {
        userId: user.id,
      });
      return jsonError(400, "Invalid user id");
    }

    const conversationId = body.id ?? generateId();
    if (conversationId.includes(":")) {
      return jsonError(400, "Invalid conversation id");
    }
    const threadId = this.threadIdFor({ user, conversationId });

    const lastUserMessage = findLastUserMessage(body.messages);
    if (!lastUserMessage) {
      return jsonError(400, "No user message found in messages array");
    }

    // The client-supplied messages array is untrusted, so only the latest
    // user message is consumed, with tool parts stripped so a browser can't
    // inject forged tool-call or approval state. Text, file, and custom data
    // parts pass through untouched. Prior turns come from the state adapter
    // (persistMessageHistory), never from the request body.
    const sanitizedMessage: UIMessage = {
      ...lastUserMessage,
      parts: lastUserMessage.parts.filter(
        (part) =>
          part.type === "text" ||
          part.type === "file" ||
          part.type.startsWith("data-")
      ),
    };
    if (sanitizedMessage.parts.length === 0) {
      return jsonError(400, "No usable content in last user message");
    }

    // A user message carrying a `data-chat-action` part is a card action, not
    // a chat message. It is dispatched only if it names a card this adapter
    // sealed for this thread; anything else is dropped.
    const actionPart = sanitizedMessage.parts.find(
      (part) => part.type === ACTION_PART_TYPE
    );
    let action: WebCardAction | null = null;
    if (actionPart) {
      const verdict = await this.verifyCardAction(
        actionPart,
        body.messages,
        threadId
      );
      if (typeof verdict === "string") {
        // Log why without the action's content: ids and values are client input.
        this.logger.warn("Dropped card action", { reason: verdict });
        return jsonError(403, "Card action rejected");
      }
      action = verdict;
    }

    const chat = this.chat;
    const dispatch = (): Promise<void> =>
      action
        ? chat.processAction(
            {
              adapter: this,
              actionId: action.actionId,
              value: action.value,
              messageId: action.cardId,
              threadId,
              user: toAuthor(user),
              raw: sanitizedMessage,
            },
            undefined
          )
        : chat.processMessage(
            this,
            threadId,
            this.buildMessageFromUI(sanitizedMessage, threadId, user)
          );

    // `originalMessages` is deliberately not passed: nothing registers
    // onFinish on this stream, so the ai SDK never consumes it, and the
    // client array must not act as a source of prior-turn state anyway.
    const stream = createUIMessageStream<UIMessage>({
      execute: async ({ writer }) => {
        const assistantMessageId = generateId();
        writer.write({ type: "start", messageId: assistantMessageId });
        writer.write({ type: "start-step" });
        const context = {
          writer,
          signal: request.signal,
          userId: user.id,
          conversationId,
          cardIds: new Set<string>(),
          closed: false,
        };
        try {
          await webRequestContext.run(context, dispatch);
        } finally {
          context.closed = true;
          writer.write({ type: "finish-step" });
          writer.write({ type: "finish" });
        }
      },
      onError: (error) =>
        // chat.processMessage already logs handler errors at ERROR level.
        // Just turn the error into a string for the SSE error chunk.
        error instanceof Error ? error.message : "Internal error",
    });

    return createUIMessageStreamResponse({ stream });
  }

  parseMessage(raw: UIMessage): Message<UIMessage> {
    const text = extractTextFromUIMessage(raw);
    // The hot path uses buildMessageFromUI (which has WebUser context) and
    // does not call this method. Round-trip rehydration paths land here
    // without a WebUser, so for assistant messages we identify the bot by
    // userName, and for user messages we leave userId as "unknown".
    const isAssistant = raw.role !== "user";
    const author = isAssistant
      ? {
          userId: this.userName,
          userName: this.userName,
          fullName: this.userName,
          isBot: true,
          isMe: true,
        }
      : {
          userId: "unknown",
          userName: "unknown",
          fullName: "unknown",
          isBot: false,
          isMe: false,
        };
    return new Message<UIMessage>({
      id: raw.id,
      threadId: "",
      text,
      formatted: parseMarkdown(text),
      raw,
      author,
      metadata: { dateSent: new Date(), edited: false },
      attachments: [],
    });
  }

  encodeThreadId(data: WebThreadIdData): string {
    return `${ADAPTER_NAME}:${data.userId}:${data.conversationId}`;
  }

  decodeThreadId(threadId: string): WebThreadIdData {
    const parts = threadId.split(":");
    if (parts.length < 3 || parts[0] !== ADAPTER_NAME) {
      throw new ValidationError(
        ADAPTER_NAME,
        `Invalid web thread id: ${threadId}`
      );
    }
    const [, userId, ...rest] = parts;
    return { userId, conversationId: rest.join(":") };
  }

  channelIdFromThreadId(threadId: string): string {
    // Web has no separate "channel" concept — each useChat conversation is
    // its own thread. Returning threadId keeps channel.messages and
    // thread.messages in sync and prevents cross-conversation bleed when
    // persistMessageHistory is enabled.
    return threadId;
  }

  isDM(_threadId: string): boolean {
    return true;
  }

  renderFormatted(content: FormattedContent): string {
    return this.formatConverter.fromAst(content);
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<UIMessage>> {
    const ctx = requireWebRequestContext();
    const id = generateId();
    const card = extractCard(message);
    if (card) {
      return this.writeCard(threadId, id, card, message);
    }
    const text = adapterPostableToText(message, this.formatConverter);
    // Skip empty messages so useChat doesn't render a blank assistant bubble.
    if (!text) {
      return {
        id,
        threadId,
        raw: assistantUIMessageFromText(id, ""),
      };
    }
    ctx.writer.write({ type: "text-start", id });
    ctx.writer.write({ type: "text-delta", id, delta: text });
    ctx.writer.write({ type: "text-end", id });
    return {
      id,
      threadId,
      raw: assistantUIMessageFromText(id, text),
    };
  }

  /**
   * Native streaming path. Pumps text chunks straight onto the per-request SSE
   * response body — no edit loop, no rate limiting concerns. Honors the
   * inbound request's abort signal so `useChat`'s `stop()` short-circuits the
   * generator on the server side.
   */
  async stream(
    threadId: string,
    iterable: AsyncIterable<string | StreamChunk>,
    _options?: StreamOptions
  ): Promise<RawMessage<UIMessage>> {
    const ctx = requireWebRequestContext();
    const id = generateId();
    let fullText = "";
    ctx.writer.write({ type: "text-start", id });
    try {
      for await (const chunk of iterable) {
        if (ctx.signal.aborted) {
          break;
        }
        const text = streamChunkToText(chunk);
        if (text) {
          fullText += text;
          ctx.writer.write({ type: "text-delta", id, delta: text });
        }
      }
    } finally {
      ctx.writer.write({ type: "text-end", id });
    }
    return {
      id,
      threadId,
      raw: assistantUIMessageFromText(id, fullText),
    };
  }

  /**
   * Edit a card posted earlier in the same response. The card's data part is
   * written again under the same id, and `useChat` replaces the earlier part
   * in place.
   *
   * Anything else throws `NotImplementedError`: a message from a response
   * that has ended can't be reached without a push channel, and text parts
   * in the UI message stream are append-only.
   */
  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<UIMessage>> {
    const ctx = webRequestContext.getStore();
    if (!ctx || ctx.closed || !ctx.cardIds.has(messageId)) {
      throw new NotImplementedError(
        "WebAdapter.editMessage can only edit a card posted earlier in the same response — once a response has ended, its messages can no longer be changed.",
        "editMessage"
      );
    }
    const card = extractCard(message);
    if (!card) {
      throw new NotImplementedError(
        "WebAdapter.editMessage can only replace a card with another card — text parts in the UI message stream can't be rewritten.",
        "editMessage"
      );
    }
    return this.writeCard(threadId, messageId, card, message);
  }

  // ---------------------------------------------------------------------------
  // Required-by-interface methods that have no native concept on web (v1 stubs)
  // ---------------------------------------------------------------------------

  deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    throw new NotImplementedError(
      "WebAdapter.deleteMessage is not supported in v1."
    );
  }

  addReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string
  ): Promise<void> {
    throw new NotImplementedError(
      "WebAdapter.addReaction is not supported in v1."
    );
  }

  removeReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string
  ): Promise<void> {
    throw new NotImplementedError(
      "WebAdapter.removeReaction is not supported in v1."
    );
  }

  startTyping(_threadId: string, _status?: string): Promise<void> {
    // useChat derives a "streaming" status from the SSE response itself, so an
    // explicit typing indicator is unnecessary on web.
    return Promise.resolve();
  }

  /**
   * Always resolves to an empty list. Web has no platform-side history API;
   * when `persistMessageHistory: true` (the default) chat-sdk's own
   * `MessageHistoryCache` backfills `thread.messages` / `channel.messages`
   * from state after this method returns.
   */
  fetchMessages(
    _threadId: string,
    _options?: FetchOptions
  ): Promise<FetchResult<UIMessage>> {
    return Promise.resolve({ messages: [] });
  }

  fetchThread(threadId: string): Promise<ThreadInfo> {
    return Promise.resolve({
      id: threadId,
      channelId: this.channelIdFromThreadId(threadId),
      isDM: true,
      metadata: {},
    });
  }

  getUser(_userId: string): Promise<UserInfo | null> {
    // The Web adapter doesn't have a user directory — host apps can supply
    // their own via WebAdapterConfig.getUser.
    return Promise.resolve(null);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  protected buildMessageFromUI(
    uiMessage: UIMessage,
    threadId: string,
    user: WebUser
  ): Message<UIMessage> {
    const text = extractTextFromUIMessage(uiMessage);
    return new Message<UIMessage>({
      id: uiMessage.id,
      threadId,
      text,
      formatted: parseMarkdown(text),
      raw: uiMessage,
      author: toAuthor(user),
      metadata: { dateSent: new Date(), edited: false },
      attachments: [],
    });
  }

  /**
   * Write a card as a `data-chat-card` part under `id`. Writing the same id
   * again (an edit) replaces the part in `useChat`'s message.
   */
  protected async writeCard(
    threadId: string,
    id: string,
    card: CardElement,
    message: AdapterPostableMessage
  ): Promise<RawMessage<UIMessage>> {
    const ctx = requireWebRequestContext();
    const fallbackText =
      (typeof message === "object" &&
        "card" in message &&
        message.fallbackText) ||
      cardToFallbackText(card, { boldFormat: "**" });
    const data: WebCardData = { card, fallbackText };
    if (this.actionSecret) {
      data.seal = await sealCard(this.actionSecret, threadId, id, card);
    }
    ctx.writer.write({ type: CARD_PART_TYPE, id, data });
    ctx.cardIds.add(id);
    return {
      id,
      threadId,
      raw: {
        id,
        role: "assistant",
        parts: [{ type: CARD_PART_TYPE, id, data }],
      },
    };
  }

  /**
   * Check a `data-chat-action` part against the card it names. Returns the
   * action when the card is in the request's messages, its seal verifies for
   * this thread, and it offered that action and value; otherwise the reason
   * it was rejected.
   *
   * Only sealed card parts are read from the rest of the (client-controlled)
   * messages array — the seal is what makes them trustworthy.
   */
  protected async verifyCardAction(
    part: unknown,
    messages: UIMessage[],
    threadId: string
  ): Promise<WebCardAction | string> {
    const secret = this.actionSecret;
    if (!secret) {
      return "actionSecret is not configured";
    }
    const action = readActionPart(part);
    if (!action) {
      return "malformed action part";
    }
    for (const candidate of messages) {
      if (candidate?.role !== "assistant" || !Array.isArray(candidate.parts)) {
        continue;
      }
      for (const candidatePart of candidate.parts) {
        const card = readCardPart(candidatePart);
        if (
          card?.id === action.cardId &&
          card.seal &&
          (await verifyCardSeal(
            secret,
            threadId,
            card.id,
            card.card,
            card.seal
          ))
        ) {
          return cardOffersAction(card.card, action.actionId, action.value)
            ? action
            : "action not offered by card";
        }
      }
    }
    return "no sealed card found for action";
  }
}

// =============================================================================
// Helpers (module-private)
// =============================================================================

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function findLastUserMessage(messages: UIMessage[]): UIMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") {
      return m;
    }
  }
  return null;
}

function extractTextFromUIMessage(message: UIMessage): string {
  return message.parts
    .filter(isTextUIPart)
    .map((p) => p.text)
    .join("\n");
}

function streamChunkToText(chunk: string | StreamChunk): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (chunk.type === "markdown_text") {
    return chunk.text;
  }
  // task_update / plan_update — no native v1 representation in UIMessage.
  // Future: emit as data-* parts. For now ignored so the stream stays clean.
  return "";
}

function adapterPostableToText(
  message: AdapterPostableMessage,
  formatConverter: WebFormatConverter
): string {
  if (typeof message === "string") {
    return message;
  }
  if ("raw" in message && typeof message.raw === "string") {
    return message.raw;
  }
  if ("markdown" in message && typeof message.markdown === "string") {
    return message.markdown;
  }
  if ("ast" in message) {
    return formatConverter.fromAst(message.ast);
  }
  // Cards are written as `data-chat-card` parts by postMessage, never as text.
  return "";
}

function toAuthor(user: WebUser): Author {
  return {
    userId: user.id,
    userName: user.name ?? user.id,
    fullName: user.name ?? user.id,
    isBot: false,
    isMe: false,
  };
}

function assistantUIMessageFromText(id: string, text: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
  };
}

function generateId(): string {
  // crypto.randomUUID is available in Node 19+ and modern browsers.
  // Fallback ensures we don't hard-fail if it's missing.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
