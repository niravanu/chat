"use client";

import type {
  ActionsElement,
  CardChild,
  RadioSelectElement,
  SelectElement,
} from "chat";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import { readCardPart, type WebCardAction } from "../card-part";

export interface ChatCardProps {
  /** Class name for the card's root element. */
  className?: string;
  /** Render every button and select as disabled (e.g. while a response streams). */
  disabled?: boolean;
  /**
   * Called when the user presses a button or picks a select option. Send the
   * action back as a `data-chat-action` part:
   *
   * ```ts
   * sendMessage({ parts: [{ type: "data-chat-action", data: action }] });
   * ```
   *
   * Without `onAction`, buttons and selects render disabled.
   */
  onAction?: (action: WebCardAction) => void;
  /** A UI message part. Anything other than a `data-chat-card` part renders nothing. */
  part: unknown;
}

type ActionHandler = (actionId: string, value?: string) => void;

const LINK_PROTOCOL_PATTERN = /^(https?|mailto):/i;
const IMAGE_PROTOCOL_PATTERN = /^(https?:|data:image\/)/i;

const ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.5rem",
};

/**
 * Renders a card posted by the Web adapter: title, subtitle, text, images,
 * fields, links, tables, buttons, and selects. Charts are not rendered yet.
 *
 * The markup is semantic and unstyled beyond a flex row for actions — target
 * `className` and the `data-chat-card*` attributes from your own CSS.
 *
 * @example
 * ```tsx
 * {message.parts.map((part, index) =>
 *   part.type === "data-chat-card" ? (
 *     <ChatCard
 *       key={index}
 *       part={part}
 *       onAction={(action) =>
 *         sendMessage({ parts: [{ type: "data-chat-action", data: action }] })
 *       }
 *     />
 *   ) : null
 * )}
 * ```
 */
export function ChatCard({
  className,
  disabled = false,
  onAction,
  part,
}: ChatCardProps): ReactElement | null {
  const cardPart = readCardPart(part);
  if (!cardPart) {
    return null;
  }
  const { card, id: cardId } = cardPart;
  const handle: ActionHandler | undefined =
    onAction && !disabled
      ? (actionId, value) =>
          onAction({
            cardId,
            actionId,
            ...(value !== undefined ? { value } : {}),
          })
      : undefined;

  return (
    <article className={className} data-chat-card={cardId}>
      {card.imageUrl ? <CardImage alt="" url={card.imageUrl} /> : null}
      {card.title ? <h3 data-chat-card-title="">{card.title}</h3> : null}
      {card.subtitle ? <p data-chat-card-subtitle="">{card.subtitle}</p> : null}
      {renderChildren(card.children, handle)}
    </article>
  );
}

function CardImage({
  alt,
  url,
}: {
  alt: string;
  url: string;
}): ReactElement | null {
  if (!IMAGE_PROTOCOL_PATTERN.test(url)) {
    return null;
  }
  // biome-ignore lint/performance/noImgElement: framework-agnostic component; next/image is not available outside Next.js
  // biome-ignore lint/correctness/useImageSize: card images carry no dimensions
  return <img alt={alt} src={url} />;
}

/** Only http(s) and mailto links are rendered as links; anything else is dropped. */
function safeHref(url: string): string | undefined {
  return LINK_PROTOCOL_PATTERN.test(url) ? url : undefined;
}

function renderChildren(
  children: CardChild[],
  handle: ActionHandler | undefined
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let position = 0;
  for (const child of children) {
    position += 1;
    nodes.push(renderChild(child, `${child.type}-${position}`, handle));
  }
  return nodes;
}

function renderChild(
  child: CardChild,
  key: string,
  handle: ActionHandler | undefined
): ReactNode {
  switch (child.type) {
    case "text":
      return (
        <p data-chat-card-text={child.style ?? "plain"} key={key}>
          {child.style === "bold" ? (
            <strong>{child.content}</strong>
          ) : (
            child.content
          )}
        </p>
      );
    case "image":
      return <CardImage alt={child.alt ?? ""} key={key} url={child.url} />;
    case "divider":
      return <hr key={key} />;
    case "link":
      return (
        <a
          href={safeHref(child.url)}
          key={key}
          rel="noopener noreferrer"
          target="_blank"
        >
          {child.label}
        </a>
      );
    case "fields":
      return (
        <dl data-chat-card-fields="" key={key}>
          {child.children.map((field) => (
            <div key={`${field.label}:${field.value}`}>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      );
    case "table":
      return (
        <table data-chat-card-table="" key={key}>
          {child.caption ? <caption>{child.caption}</caption> : null}
          <thead>
            <tr>
              {child.headers.map((header) => (
                <th key={header} scope="col">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {child.rows.map((row) => (
              <tr key={row.join("\u0000")}>
                {row.map((cell, column) => (
                  <td key={child.headers[column] ?? cell}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "section":
      return (
        <section data-chat-card-section="" key={key}>
          {renderChildren(child.children, handle)}
        </section>
      );
    case "actions":
      return renderActions(child, key, handle);
    default:
      return null;
  }
}

function renderActions(
  actions: ActionsElement,
  key: string,
  handle: ActionHandler | undefined
): ReactElement {
  const nodes: ReactNode[] = [];
  let position = 0;
  for (const action of actions.children) {
    position += 1;
    const actionKey = `${action.type}-${position}`;
    switch (action.type) {
      case "button":
        nodes.push(
          <button
            data-style={action.style ?? "default"}
            disabled={!handle || action.disabled === true}
            key={actionKey}
            onClick={() => handle?.(action.id, action.value)}
            title={action.tooltip}
            type="button"
          >
            {action.label}
          </button>
        );
        break;
      case "link-button":
        nodes.push(
          <a
            data-style={action.style ?? "default"}
            href={safeHref(action.url)}
            key={actionKey}
            rel="noopener noreferrer"
            target="_blank"
            title={action.tooltip}
          >
            {action.label}
          </a>
        );
        break;
      case "select":
        nodes.push(renderSelect(action, actionKey, handle));
        break;
      case "radio_select":
        nodes.push(renderRadioSelect(action, actionKey, handle));
        break;
      default:
        break;
    }
  }
  return (
    <div data-chat-card-actions="" key={key} style={ACTIONS_STYLE}>
      {nodes}
    </div>
  );
}

function renderSelect(
  select: SelectElement,
  key: string,
  handle: ActionHandler | undefined
): ReactElement {
  return (
    <label key={key}>
      {select.label}{" "}
      <select
        defaultValue={select.initialOption ?? ""}
        disabled={!handle}
        onChange={(event) => {
          if (event.target.value) {
            handle?.(select.id, event.target.value);
          }
        }}
      >
        <option disabled value="">
          {select.placeholder ?? "Select…"}
        </option>
        {select.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function renderRadioSelect(
  select: RadioSelectElement,
  key: string,
  handle: ActionHandler | undefined
): ReactElement {
  return (
    <fieldset disabled={!handle} key={key}>
      <legend>{select.label}</legend>
      {select.options.map((option) => (
        <label key={option.value}>
          <input
            defaultChecked={select.initialOption === option.value}
            name={`${select.id}-${key}`}
            onChange={() => handle?.(select.id, option.value)}
            type="radio"
            value={option.value}
          />{" "}
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
