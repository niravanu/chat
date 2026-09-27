import type { CardElement } from "chat";

/**
 * Framework-agnostic helpers for the card and action data parts the Web
 * adapter exchanges with the browser. Kept free of server and framework
 * imports so every client entry point (`/react`, `/vue`, `/svelte`) can
 * re-export them.
 */

/** Type of the UI message data part that carries a posted card. */
export const CARD_PART_TYPE = "data-chat-card";

/** Type of the UI message data part that carries a card action (button press). */
export const ACTION_PART_TYPE = "data-chat-action";

/** Payload of a `data-chat-card` part. The part's `id` is the card's message id. */
export interface WebCardData {
  /** The card, as posted by the bot. */
  card: CardElement;
  /** Plain-text rendering of the card for clients that don't render cards. */
  fallbackText: string;
  /**
   * HMAC-SHA256 seal over the thread id, the card id and the card's actions.
   * Present only when the adapter is configured with `actionSecret`.
   */
  seal?: string;
}

/**
 * Payload of a `data-chat-action` part. Send it in a user message to press a
 * card's button or pick one of its select options:
 *
 * ```ts
 * sendMessage({ parts: [{ type: "data-chat-action", data: action }] });
 * ```
 */
export interface WebCardAction {
  /** The action id of the button or select. */
  actionId: string;
  /** Id of the `data-chat-card` part the action belongs to. */
  cardId: string;
  /** The button's value, or the selected option's value. */
  value?: string;
}

/** A `data-chat-card` part read by `readCardPart`. */
export interface WebCardPart extends WebCardData {
  /** The card's message id — pass it back as `cardId` in a `WebCardAction`. */
  id: string;
}

/**
 * Read a UI message part as a card posted by the Web adapter.
 *
 * Returns `null` for any other part, or for a card part whose payload is
 * malformed.
 */
export function readCardPart(part: unknown): WebCardPart | null {
  if (!isObject(part) || part.type !== CARD_PART_TYPE) {
    return null;
  }
  const { id, data } = part;
  if (typeof id !== "string" || !isObject(data)) {
    return null;
  }
  const { card, fallbackText, seal } = data;
  if (
    !isObject(card) ||
    card.type !== "card" ||
    !Array.isArray(card.children)
  ) {
    return null;
  }
  return {
    id,
    card: card as unknown as CardElement,
    fallbackText: typeof fallbackText === "string" ? fallbackText : "",
    ...(typeof seal === "string" ? { seal } : {}),
  };
}

/**
 * Read a UI message part as a card action.
 *
 * Returns `null` for any other part, or for an action part whose payload is
 * malformed.
 */
export function readActionPart(part: unknown): WebCardAction | null {
  if (!isObject(part) || part.type !== ACTION_PART_TYPE) {
    return null;
  }
  const { data } = part;
  if (!isObject(data)) {
    return null;
  }
  const { actionId, cardId, value } = data;
  if (
    typeof actionId !== "string" ||
    !actionId ||
    typeof cardId !== "string" ||
    !cardId ||
    (value !== undefined && typeof value !== "string")
  ) {
    return null;
  }
  return { actionId, cardId, ...(value !== undefined ? { value } : {}) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
