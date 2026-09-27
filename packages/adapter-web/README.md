[![Web adapter for Chat SDK](https://chat-sdk.dev/en/adapters/official/web/og)](https://chat-sdk.dev/adapters/official/web)

# @chat-adapter/web

> npm package: [`@chat-adapter/web`](https://www.npmjs.com/package/@chat-adapter/web)

[![Agent Stack](https://img.shields.io/badge/Agent%20Stack-000?style=flat-square&logo=vercel&logoColor=FFF&labelColor=000&color=000)](https://vercel.com/kb/agent-stack)
[![MIT License](https://img.shields.io/badge/License-MIT-000?style=flat-square&logo=opensourceinitiative&logoColor=white&labelColor=000&color=000)](../../LICENSE)

Web adapter for [Chat SDK](https://chat-sdk.dev). Lets a chat-sdk bot serve a browser chat UI alongside Slack, Teams, Discord, etc. — the same `bot.onDirectMessage(...)` handler fires for every platform.

The adapter speaks the [AI SDK UI message stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol), so React, Vue, and Svelte AI SDK clients work against the same server endpoint.

Documentation: [chat-sdk.dev/adapters/official/web](https://chat-sdk.dev/adapters/official/web) · Guides: [vercel.com/kb/chat-sdk](https://vercel.com/kb/chat-sdk)

## Installation

```bash
pnpm add @chat-adapter/web ai
```

Then install the framework package that matches your UI:

| Framework | Package | Import from |
|-----------|---------|-------------|
| React / Next.js | `@ai-sdk/react` | `@chat-adapter/web/react` |
| Vue / Nuxt | `@ai-sdk/vue` | `@chat-adapter/web/vue` |
| Svelte / SvelteKit | `@ai-sdk/svelte` | `@chat-adapter/web/svelte` |

## Scaffold with the CLI

To scaffold a new browser chat bot with the Web adapter preselected:

```bash
npx create-chat-sdk@latest my-bot --adapter web memory
```

Visit the [adapters directory](https://chat-sdk.dev/adapters) to see other available official and vendor-official adapters.

## Quick start

### Server

```typescript
// lib/bot.ts
import { Chat } from "chat";
import { createWebAdapter } from "@chat-adapter/web";
import { createMemoryState } from "@chat-adapter/state-memory";

export const bot = new Chat({
  userName: "mybot",
  adapters: {
    web: createWebAdapter({
      userName: "mybot",
      getUser: (req) => ({ id: getUserIdFromCookie(req) }),
    }),
  },
  state: createMemoryState(),
});

bot.onDirectMessage(async (thread, message) => {
  await thread.post(`You said: ${message.text}`);
});
```

```typescript
// app/api/chat/route.ts
import { after } from "next/server";
import { bot } from "@/lib/bot";

export async function POST(request: Request): Promise<Response> {
  return bot.webhooks.web(request, {
    waitUntil: (task) => after(() => task),
  });
}
```

### Client

#### React

```tsx
// app/chat/page.tsx
"use client";
import { useChat } from "@chat-adapter/web/react";

export default function ChatPage() {
  const { messages, sendMessage, status, stop } = useChat();
  // Render with `ai-elements` (<Conversation>, <Message>, <PromptInput>)
  // or your own components — `messages`, `sendMessage`, `status` are the
  // standard `@ai-sdk/react` API.
}
```

#### Vue

```vue
<!-- components/Chat.vue -->
<script setup lang="ts">
import { useChat } from "@chat-adapter/web/vue";

const chat = useChat({ api: "/api/chat" });
</script>

<template>
  <div v-for="msg in chat.messages" :key="msg.id">
    <template
      v-for="(part, index) in msg.parts"
      :key="`${msg.id}-${part.type}-${index}`"
    >
      <p v-if="part.type === 'text'">{{ part.text }}</p>
    </template>
  </div>
</template>
```

#### Svelte

```svelte
<!-- Chat.svelte -->
<script lang="ts">
  import { useChat } from "@chat-adapter/web/svelte";

  const chat = useChat({ api: "/api/chat" });
</script>

{#each chat.messages as msg (msg.id)}
  {#each msg.parts as part, index (`${msg.id}-${part.type}-${index}`)}
    {#if part.type === "text"}<p>{part.text}</p>{/if}
  {/each}
{/each}
```

## Authentication

`getUser` is the **security boundary** for the Web adapter. Unlike Slack/Teams where the platform signs every webhook, web requests come straight from a browser — you must identify the caller yourself. Returning `null` causes the adapter to respond with HTTP 401 and no handler runs.

Plug in whatever your app already uses:

```typescript
// NextAuth
createWebAdapter({
  userName: "mybot",
  getUser: async (req) => {
    const session = await getServerSession(authOptions);
    if (!session?.user) return null;
    return { id: session.user.id, name: session.user.name };
  },
});

// Clerk
createWebAdapter({
  userName: "mybot",
  getUser: async (req) => {
    const { userId, sessionClaims } = await auth();
    if (!userId) return null;
    return { id: userId, name: sessionClaims?.name as string | undefined };
  },
});

// Custom session cookie
createWebAdapter({
  userName: "mybot",
  getUser: async (req) => {
    const sessionId = req.headers.get("cookie")?.match(/session=([^;]+)/)?.[1];
    if (!sessionId) return null;
    const user = await db.users.findBySession(sessionId);
    return user ? { id: user.id, name: user.name } : null;
  },
});
```

If `getUser` throws, the adapter returns 401 and logs the error. Don't include sensitive data in the error message — it's not surfaced to the client, but it is logged.

> The resolved `user.id` is embedded in the chat-sdk thread id (see [Threading](#threading) below). User ids containing `:` are rejected with HTTP 400 because they would corrupt the round-trip through `decodeThreadId`. If your auth provider emits ids with colons (e.g. `provider:sub` claims), normalize them inside `getUser` — for example by base64-encoding.

## Threading

By default, each `useChat` conversation maps to one chat-sdk thread:

```
web:{user.id}:{conversationId}
```

`conversationId` is the `id` field useChat sends in its request body. If your client supplies one (`useChat({ id: "support-chat" })`), it's reused across reloads; otherwise a fresh id is generated per request.

`channel.messages` and `thread.messages` are equivalent on web — the channel id is the thread id. This avoids cross-conversation bleed when `persistMessageHistory` is enabled and the same user has multiple useChat conversations open.

To override (for example, one thread per user regardless of conversation):

```typescript
createWebAdapter({
  userName: "mybot",
  getUser: (req) => /* ... */,
  threadIdFor: ({ user }) => `web:${user.id}:default`,
});
```

The encode/decode helpers are exposed on the adapter:

```typescript
adapter.encodeThreadId({ userId: "u1", conversationId: "abc" });
// → "web:u1:abc"
adapter.decodeThreadId("web:u1:abc");
// → { userId: "u1", conversationId: "abc" }
```

## Streaming

`thread.post` accepts an `AsyncIterable<string | StreamChunk>` and pumps deltas straight onto the SSE response body — no edit loop, no rate limiting. Plays nicely with the AI SDK's `streamText`:

```typescript
import { streamText } from "ai";
// Bring your own model from any AI SDK provider
// (@ai-sdk/openai, @ai-sdk/anthropic, @ai-sdk/google, ...).

bot.onDirectMessage(async (thread, message) => {
  const result = streamText({
    model: myModel,
    prompt: message.text,
  });
  await thread.post(result.textStream);
});
```

The adapter honors `request.signal`, so calling `stop()` from `useChat` short-circuits the iterator on the server. `task_update` and `plan_update` `StreamChunk`s have no native v1 representation in the UI message stream and are dropped silently.

## Cards and actions

Posting a card writes a `data-chat-card` [data part](https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data) to the response. The part's `id` is the message id, and its `data` carries the card (`card`), a plain-text rendering (`fallbackText`) for clients that don't render cards, and — when `actionSecret` is set — a `seal`.

```tsx
bot.onDirectMessage(async (thread) => {
  await thread.post(
    <Card title="Lunch?">
      <Actions>
        <Button id="vote" value="pizza">Pizza</Button>
        <Button id="vote" value="salad">Salad</Button>
      </Actions>
    </Card>
  );
});

bot.onAction("vote", async (event) => {
  await event.thread?.post(`You picked ${event.value}`);
});
```

On the client, render card parts with `<ChatCard>` from `@chat-adapter/web/react`, and send a press back as a user message carrying a `data-chat-action` part (`{ cardId, actionId, value }`):

```tsx
import { ChatCard, useChat } from "@chat-adapter/web/react";

const { messages, sendMessage } = useChat();

{message.parts.map((part, index) =>
  part.type === "data-chat-card" ? (
    <ChatCard
      key={index}
      part={part}
      onAction={(action) =>
        sendMessage({ parts: [{ type: "data-chat-action", data: action }] })
      }
    />
  ) : null
)}
```

`<ChatCard>` renders semantic, unstyled markup (title, subtitle, text, images, fields, links, tables, buttons, link buttons, selects, and radio selects) — style it through `className` and the `data-chat-card*` attributes. Vue and Svelte renderers are not included yet; `readCardPart` (exported from every entry point) reads a card part for your own renderer.

### Verifying actions

The request body is client-controlled, and a press arrives in a later request than its card, so the adapter only dispatches a press for a card it sealed:

- the user message carries a `data-chat-action` part and is routed to `chat.processAction` (your `onAction` handlers), not to `processMessage`;
- the card it names must be in the request's `messages`, with a seal that verifies for this thread under `actionSecret` (HMAC-SHA256 via Web Crypto over the thread id, the card id, and the card's actions and values);
- the card must offer that action id with that value (a button's value, or one of a select's options).

Anything else is dropped with HTTP 403 and a warning log that omits the action's content. **Without `actionSecret`, cards are still posted but every press is refused.** Tool and approval parts are stripped from a press message just as from any other user message.

A seal proves the adapter posted the card in that thread, not that the press is new: the same card can be pressed again, so make action handlers idempotent (as you would on Slack).

### Editing

`editMessage` (`sentMessage.edit(...)`) can replace a card posted earlier in the **same** response: the card part is written again under the same id, and `useChat` replaces it in place. Editing a text message, or any message after its response has ended, throws `NotImplementedError` — that needs a push channel the adapter doesn't have.

## Message persistence

`persistMessageHistory` defaults to **`true`**. Web has no platform-side history API, so the only way for chat-sdk handlers to see prior turns via `thread.messages` / `channel.messages` is through the configured state adapter's message history cache. Set it to `false` only if your handler re-derives history from the request body's `messages[]` itself:

```typescript
createWebAdapter({
  userName: "mybot",
  getUser: (req) => /* ... */,
  persistMessageHistory: false,
});
```

The AI SDK client retains the conversation in its UI state and resends it on every request, so opting out is a valid choice for stateless handlers — but anything that calls `await thread.messages` won't see prior turns.

## Framework helpers

`@chat-adapter/web/react` exports a thin wrapper around `@ai-sdk/react`'s `useChat` preconfigured with `DefaultChatTransport`:

```tsx
import { useChat } from "@chat-adapter/web/react";

const { messages, sendMessage, status, stop, regenerate } = useChat({
  api: "/api/chat",        // default
  threadId: "support-1",   // becomes useChat's `id` and the request body's `id`
});
```

| Option | Description |
|--------|-------------|
| `api` | API endpoint for the Web adapter route. Defaults to `/api/chat`. |
| `threadId` | chat-sdk thread id — surfaces in the request body's `id` so the server can derive the chat-sdk thread id. Strongly recommended. Falls back to `id` from `ChatInit`. |
| `experimental_throttle` | Throttle wait in ms for chat messages and data updates. |
| `resume` | Whether to resume an ongoing chat generation stream. |
| ...rest | All other options pass through to `@ai-sdk/react`'s `useChat`. |

For advanced configuration (custom transport, response interceptors, etc.) use `@ai-sdk/react`'s `useChat` directly — there's nothing magical in the wrapper.

`@chat-adapter/web/vue` exports a `useChat` factory that returns a Vue-reactive `Chat` instance from `@ai-sdk/vue`:

```vue
<script setup lang="ts">
import { useChat } from "@chat-adapter/web/vue";

const chat = useChat({ api: "/api/chat", threadId: "support-1" });
</script>

<template>
  <div v-for="msg in chat.messages" :key="msg.id">
    <template
      v-for="(part, index) in msg.parts"
      :key="`${msg.id}-${part.type}-${index}`"
    >
      <p v-if="part.type === 'text'">{{ part.text }}</p>
    </template>
  </div>
</template>
```

`@chat-adapter/web/svelte` exports a `useChat` factory that returns a Svelte-reactive `Chat` instance from `@ai-sdk/svelte`:

```svelte
<script lang="ts">
  import { useChat } from "@chat-adapter/web/svelte";

  const chat = useChat({ api: "/api/chat", threadId: "support-1" });
</script>

{#each chat.messages as msg (msg.id)}
  {#each msg.parts as part, index (`${msg.id}-${part.type}-${index}`)}
    {#if part.type === "text"}<p>{part.text}</p>{/if}
  {/each}
{/each}
```

Unlike the React helper, Vue and Svelte return the `Chat` instance directly. Access `chat.messages`, `chat.sendMessage()`, `chat.status`, and `chat.stop()` on that object instead of destructuring.

## Configuration

| Option | Required | Description |
|--------|----------|-------------|
| `userName` | Yes | Bot username. Required by chat-sdk for mention detection (`@username`) and seeds the bot identity for assistant messages. |
| `getUser` | Yes | `(request: Request) => WebUser \| null \| Promise<WebUser \| null>`. Resolves the user from the inbound HTTP request. Returning `null` produces HTTP 401. |
| `persistMessageHistory` | No | Persist incoming message history in the configured state adapter. Default: `true`. |
| `threadIdFor` | No | Derive a chat-sdk thread id from the resolved user and the useChat conversation id. Default: `web:{user.id}:{conversationId}`. |
| `actionSecret` | No | Secret used to seal posted cards so their actions can be verified (see [Verifying actions](#verifying-actions)). Without it, every card action is refused. |
| `logger` | No | Logger instance (defaults to `ConsoleLogger("info")`). |

## Features

### Messaging

| Feature | Supported |
|---------|-----------|
| Post message | Yes |
| Edit message | Cards, within the same response |
| Delete message | No |
| File uploads | No (deferred to v2) |
| Streaming | Native (SSE / UI message stream) |
| Scheduled messages | No |

### Rich content

| Feature | Supported |
|---------|-----------|
| Card format | `data-chat-card` part (React `<ChatCard>` renderer) |
| Buttons | Yes (sealed with `actionSecret`) |
| Link buttons | Yes |
| Select menus | Yes |
| Tables | Yes (GFM markdown) |
| Modals | No |

### Conversations

| Feature | Supported |
|---------|-----------|
| Mentions | N/A (every web message routes as a DM) |
| Add reactions | No |
| Remove reactions | No |
| Typing indicator | N/A (useChat derives a `status` from the SSE response itself) |
| DMs | Yes — `isDM: true` for every thread |

### Message history

| Feature | Supported |
|---------|-----------|
| Fetch messages | Via state adapter cache (no platform API) |
| Fetch single message | No |
| Fetch thread info | Yes (synthesized) |
| Fetch channel messages | Via state adapter cache |
| List threads | No |
| Post channel message | No |

## v1 scope

**In:** text + markdown, native streaming, DM-style routing, persisted message history, abort propagation via `request.signal`, cards and card actions, card edits within the same response.

**Out (deferred to v2):** reactions, modals, file uploads, delete, edits after a response has ended, postable objects (`Plan`), multi-tab proactive push.

## Troubleshooting

### Every request returns 401

- `getUser` is returning `null` or throwing. Add a log inside it to confirm the request actually carries the session you expect.
- Cookies aren't being forwarded — check that `useChat` is mounted on the same origin as `/api/chat` (or that your transport passes credentials).

### Every request returns 400 "Invalid user id"

- The id returned by `getUser` contains a `:` character, which would corrupt the thread-id round-trip. Normalize the id inside `getUser` (for example, `id.replace(/:/g, "_")` or base64-encode it).

### Every card press returns 403

- `actionSecret` isn't set — without it, every press is refused.
- The client isn't sending the card back: the assistant message holding the `data-chat-card` part (with its `seal`) must be in the request's `messages`. `useChat` sends the whole conversation by default.
- The press names an action or value the card didn't offer, or the card was changed on the client.

### `useChat` recreates state on every render

- Don't pass `id: undefined` to `useChat`. The wrapper guards against this internally — but if you're calling `@ai-sdk/react`'s `useChat` directly, omit `id` rather than passing `undefined`.

### `thread.messages` is empty

- `persistMessageHistory` is `false` and there is no platform-side history to fall back on. Either set it to `true` (the default) or read history from the request body's `messages[]` directly inside your handler.

## AI Coding Agents

If you use an AI coding agent such as OpenAI Codex, Claude Code, or Cursor, install the Chat SDK skill so it knows the SDK APIs, adapter patterns, and project conventions before writing code.

```bash
npx skills add vercel/chat
```

The skill references bundled documentation in `node_modules/chat/docs`, plus adapter guides and starter templates in the published package.

You can also install the [Vercel Plugin](https://vercel.com/docs/agent-resources/vercel-plugin) for a broader agent toolkit — it includes the Chat SDK skill alongside specialist agents, agent slash commands, and more:

```bash
npx plugins add vercel/vercel-plugin
```

The plugin is optional; the skill alone is enough to build with Chat SDK.

For agent-readable documentation, see [chat-sdk.dev/llms.txt](https://chat-sdk.dev/llms.txt) (page index) or [chat-sdk.dev/llms-full.txt](https://chat-sdk.dev/llms-full.txt) (full text).

## License

MIT
