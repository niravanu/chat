/**
 * Card seals.
 *
 * A card action arrives in a later request than its card, and the request
 * body is client-controlled, so the adapter cannot trust the client's copy of
 * the card. Each posted card instead carries an HMAC-SHA256 seal over the
 * thread id, the card id and the actions the card offers. A press is accepted
 * only if the card it names verifies and offered that action and value.
 *
 * Uses Web Crypto so it runs on Node, edge, and worker runtimes alike.
 */

type OfferedAction = [actionId: string, value: string | null];

const SEAL_PATTERN = /^[0-9a-f]{64}$/;
const HEX_PAIR_PATTERN = /../g;

const encoder = new TextEncoder();

/** Seal a card posted to `threadId` under `cardId`. Returns a hex digest. */
export async function sealCard(
  secret: string,
  threadId: string,
  cardId: string,
  card: unknown
): Promise<string> {
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    sealPayload(threadId, cardId, card)
  );
  return toHex(new Uint8Array(signature));
}

/** Verify a seal produced by `sealCard`. */
export async function verifyCardSeal(
  secret: string,
  threadId: string,
  cardId: string,
  card: unknown,
  seal: string
): Promise<boolean> {
  if (!SEAL_PATTERN.test(seal)) {
    return false;
  }
  const key = await importKey(secret);
  return crypto.subtle.verify(
    "HMAC",
    key,
    fromHex(seal),
    sealPayload(threadId, cardId, card)
  );
}

/** Whether the card offers `actionId` with `value` (a button, or a select option). */
export function cardOffersAction(
  card: unknown,
  actionId: string,
  value: string | undefined
): boolean {
  const expected = value ?? null;
  return offeredActions(card).some(
    ([id, offered]) => id === actionId && offered === expected
  );
}

function sealPayload(
  threadId: string,
  cardId: string,
  card: unknown
): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    JSON.stringify([threadId, cardId, offeredActions(card)])
  );
}

/**
 * The actions a card offers, in document order: one entry per enabled
 * button, and one per option of each select or radio select. Link buttons
 * open a URL and never reach the server, so they are not included.
 *
 * Reads untrusted JSON defensively — a card supplied by a client may have any
 * shape, and must derive the same list the server sealed or fail to verify.
 */
function offeredActions(card: unknown): OfferedAction[] {
  const offered: OfferedAction[] = [];
  const visit = (node: unknown): void => {
    if (!isObject(node)) {
      return;
    }
    const id = typeof node.id === "string" ? node.id : null;
    switch (node.type) {
      case "button":
        if (id && node.disabled !== true) {
          offered.push([
            id,
            typeof node.value === "string" ? node.value : null,
          ]);
        }
        return;
      case "select":
      case "radio_select":
        if (id && Array.isArray(node.options)) {
          for (const option of node.options) {
            if (isObject(option) && typeof option.value === "string") {
              offered.push([id, option.value]);
            }
          }
        }
        return;
      default:
        if (Array.isArray(node.children)) {
          for (const child of node.children) {
            visit(child);
          }
        }
    }
  };
  visit(card);
  return offered;
}

function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const pairs = hex.match(HEX_PAIR_PATTERN) ?? [];
  return new Uint8Array(pairs.map((pair) => Number.parseInt(pair, 16)));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
