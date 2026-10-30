/**
 * Which tab the chat panel is rendering.
 *
 * - `chat`    — message feed + composer + queue panel.
 * - `changes` — `ds-diff-viewer` over the project's working tree.
 *
 * Persisted only in-memory: switching projects always resets to `chat`.
 */
export type ChatView = 'chat' | 'changes';
