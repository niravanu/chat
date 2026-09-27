import type { Logger } from "chat";

/** Identity resolved from an inbound web request. */
export interface WebUser {
  /** Stable user identifier. Used to scope thread IDs and as the message author id. */
  id: string;
  /** Optional display name. Falls back to `id` when omitted. */
  name?: string;
}

export interface WebAdapterConfig {
  /**
   * Secret used to seal posted cards so their actions can be verified.
   *
   * A card action (button press or select) arrives as a `data-chat-action`
   * part in a later request, and the request body is client-controlled. When
   * set, every posted card carries an HMAC-SHA256 seal over the thread id, the
   * card id and the card's actions; an action is dispatched to `onAction` only
   * if its sealed card is in the request's messages, the seal verifies, and
   * the card offered that action and value.
   *
   * Default: unset — cards are still posted, but every card action is refused.
   * Use a long random value and keep it server-side (e.g. an env var).
   */
  actionSecret?: string;
  /**
   * Resolve the user from the inbound HTTP request.
   *
   * Required — this is the security boundary for the Web adapter. Returning
   * `null` causes the adapter to respond with HTTP 401. Use your auth provider
   * (NextAuth, Clerk, custom session cookie, etc.) here.
   */
  getUser: (request: Request) => WebUser | null | Promise<WebUser | null>;
  /** Optional logger override. */
  logger?: Logger;
  /**
   * When true, chat-sdk persists incoming message history in the configured state adapter.
   *
   * Default: `true`. Web has no platform-side history API, so the only way for
   * chat-sdk handlers to see prior turns via `thread.messages` / `channel.messages`
   * is through the configured state adapter's message history cache. Set to
   * `false` only if your handler re-derives history from the request body's
   * `messages[]` itself.
   */
  persistMessageHistory?: boolean;
  /**
   * Derive a chat-sdk thread id from the resolved user and the useChat conversation id.
   *
   * Default: `web:{user.id}:{conversationId}` — one thread per useChat conversation.
   * Override to implement different threading semantics (e.g., one thread per user).
   */
  threadIdFor?: (args: { user: WebUser; conversationId: string }) => string;
  /**
   * Bot username. Required by chat-sdk for mention detection (`@username`).
   * Web messages are routed as DMs so mention detection rarely matters in practice,
   * but this also seeds the message author identity for bot-emitted messages.
   */
  userName: string;
}

/**
 * @deprecated Use `WebAdapterConfig`. Kept as an alias for backwards
 * compatibility with the previous name.
 */
export type WebAdapterOptions = WebAdapterConfig;
