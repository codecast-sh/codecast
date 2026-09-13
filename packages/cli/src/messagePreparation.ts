import { redactSecrets } from './redact.js';
import { detectImageMediaType } from './imagePayload.js';
import { filesForWire, type SyncFile } from './userFiles.js';

export type PreparationImage = { mediaType: string; data?: string; localPath?: string; storageId?: string; toolUseId?: string };
export type { SyncFile as PreparationFile } from './userFiles.js';
export type PreparationMessage = {
  uuid?: string;
  messageUuid?: string;
  role: string;
  content: string;
  timestamp: number;
  thinking?: string;
  toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  toolResults?: Array<{ toolUseId: string; content: string; isError?: boolean }>;
  images?: PreparationImage[];
  files?: SyncFile[];
  subtype?: string;
  model?: string;
};
export type PreparationOrigin = 'transcript' | 'service';
export type PreparedWireMessage = ReturnType<typeof finishPreparationMessage>;
const LOCAL_IMAGE_LINK_RE = /(!?\[[^\]\n]*\]\()((?:\/|~\/)[^)\s]+?\.(?:png|jpe?g|gif|webp|avif|bmp))(\))/gi;

export function validResolvedPreparationImage(img: PreparationImage): boolean {
  if (img.storageId) return typeof img.storageId === 'string';
  if (!img.data || img.localPath) return false;
  const normalized = img.data.replace(/\s/g, '');
  if (!normalized.length || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return false;
  const data = Buffer.from(normalized, 'base64');
  if (data.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) return false;
  const mediaType = detectImageMediaType(data);
  return !!mediaType && data.length <= 500_000 && mediaType === img.mediaType;
}

export function beginMessagePreparation(messages: PreparationMessage[], origin: PreparationOrigin): PreparationMessage[] {
  return messages.map(msg => origin === 'service' ? { ...msg } : {
    messageUuid: msg.uuid,
    role: msg.role === 'user' ? 'human' : msg.role === 'system' ? 'system' : 'assistant',
    content: redactSecrets(msg.content),
    timestamp: msg.timestamp,
    thinking: msg.thinking,
    toolCalls: msg.toolCalls,
    toolResults: msg.toolResults,
    images: msg.images,
    files: msg.files,
    subtype: msg.subtype,
    model: msg.model,
  });
}

export function preparationImagePaths(msg: PreparationMessage): string[] {
  if (msg.role !== 'assistant' || !msg.content || !msg.content.includes('](')) return [];
  const scan = new RegExp(LOCAL_IMAGE_LINK_RE.source, 'gi'), paths = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = scan.exec(msg.content)) !== null && paths.size < 8) paths.add(match[2]);
  return [...paths];
}

export function replacePreparationImageLinks(msg: PreparationMessage, replacements: ReadonlyMap<string, string>): void {
  if (!replacements.size) return;
  msg.content = msg.content.replace(new RegExp(LOCAL_IMAGE_LINK_RE.source, 'gi'), (full, open: string, linkPath: string, close: string) => {
    const url = replacements.get(linkPath);
    return url ? `${open}${url}${close}` : full;
  });
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit) + `\n... [truncated ${value.length - limit} chars]`;
}

export function finishPreparationMessage(msg: PreparationMessage) {
  const images = msg.images?.slice(0, 10).flatMap<{ media_type: string; storage_id?: string; data?: string; tool_use_id?: string }>(img => img.storageId
    ? [{ media_type: img.mediaType, storage_id: img.storageId, tool_use_id: img.toolUseId }]
    : img.data ? [{ media_type: img.mediaType, data: img.data, tool_use_id: img.toolUseId }] : []);
  const roleMap: Record<string, 'user' | 'assistant' | 'system' | 'tool'> = { human: 'user', assistant: 'assistant', system: 'system' };
  return {
    message_uuid: msg.messageUuid,
    role: roleMap[msg.role],
    content: truncate(redactSecrets(msg.content), 100_000),
    thinking: msg.thinking ? truncate(redactSecrets(msg.thinking), 100_000) : undefined,
    tool_calls: msg.toolCalls?.map(tc => ({ id: tc.id, name: tc.name, input: truncate(redactSecrets(JSON.stringify(tc.input)), 50_000) })),
    tool_results: msg.toolResults?.map(tr => ({ tool_use_id: tr.toolUseId, content: truncate(redactSecrets(tr.content), 50_000), is_error: tr.isError })),
    images: images?.length ? images : undefined,
    files: filesForWire(msg.files),
    subtype: msg.subtype,
    model: msg.model,
    timestamp: msg.timestamp,
  };
}
