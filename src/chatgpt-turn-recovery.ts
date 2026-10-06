import { parseDevosResult } from './result.js';
export interface SubmittedTurn {
  messageId: string;
  conversationId?: string;
  requestId?: string;
  turnExchangeId?: string;
}
type RecordValue = Record<string, any>;
function record(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
/** Fail closed: ancestry, not recency, ties a final message to the outgoing user. */
export function readCompletedTurn(data: unknown, conversationId: string, turn: SubmittedTurn): string | null {
  if (!record(data) || (data.conversation_id ?? data.id) !== conversationId || !record(data.mapping)) {
    throw new Error('Recovery conversation identity absent or changed');
  }
  const mapping = data.mapping;
  const users = Object.entries(mapping).filter(([, node]) => record(node) && node.message?.id === turn.messageId);
  if (users.length !== 1)
    throw new Error('Recovery submitted user identity absent or ambiguous');
  const [userKey, userNode] = users[0]!;
  if (!record(userNode) || userNode.message.author?.role !== 'user')
    throw new Error('Recovery submitted identity is not a user message');
  const userMetadata = userNode.message.metadata ?? {};
  if (turn.turnExchangeId && userMetadata.turn_exchange_id !== turn.turnExchangeId)
    throw new Error('Recovery user turn identity changed');
  const candidates: RecordValue[] = [];
  for (const [key, node] of Object.entries(mapping)) {
    if (!record(node) || key === userKey || !record(node.message))
      continue;
    const message = node.message;
    if (message.author?.role !== 'assistant')
      continue;
    let parent = node.parent;
    const visited = new Set<string>([key]);
    let matching = false;
    while (typeof parent === 'string' && !visited.has(parent)) {
      if (parent === userKey) {
        matching = true;
        break;
      }
      visited.add(parent);
      const ancestor = mapping[parent];
      if (!record(ancestor) || ancestor.message?.author?.role === 'user')
        break;
      parent = ancestor.parent;
    }
    if (!matching)
      continue;
    const metadata = message.metadata ?? {};
    for (const [field, expected] of [
      ['turn_exchange_id', turn.turnExchangeId ?? userMetadata.turn_exchange_id],
      ['request_id', turn.requestId ?? userMetadata.request_id],
    ] as const) {
      if (expected && metadata[field] && metadata[field] !== expected)
        throw new Error('Recovery assistant turn identity changed');
    }
    if (/failed|cancelled|incomplete|error/i.test(String(message.status)))
      throw new Error('Recovery submitted turn failed');
    if (message.channel === 'final' && message.status === 'finished_successfully' && message.end_turn === true)
      candidates.push(message);
  }
  if (candidates.length > 1)
    throw new Error('Recovery final identity ambiguous');
  if (!candidates.length)
    return null;
  const content = candidates[0]!.content;
  if (!record(content) || content.content_type !== 'text' || !Array.isArray(content.parts) || !content.parts.every((part: unknown) => typeof part === 'string'))
    throw new Error('Recovery final content unavailable');
  const text = content.parts.join('');
  parseDevosResult(text);
  return text;
}
