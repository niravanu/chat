---
"@chat-adapter/web": minor
---

Add cards, card actions, and in-response card edits to the Web adapter. Posting a card writes a `data-chat-card` UI message data part (the card, its fallback text, and a seal), rendered by the new `<ChatCard>` component in `@chat-adapter/web/react`. A user message carrying a `data-chat-action` part is routed to `onAction` handlers — but only for a card sealed under the new `actionSecret` option (HMAC-SHA256 over the thread id, card id, and the card's actions); anything else is rejected with HTTP 403, and without `actionSecret` every action is refused. `editMessage` can now replace a card posted earlier in the same response.
