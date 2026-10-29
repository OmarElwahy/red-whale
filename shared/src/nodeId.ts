// Deterministic IDs (docs/architecture.md §3). Tool scripts never create IDs; the server does, here.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { NodeType, Relation } from './enums';
import { normalize } from './normalize';

/** First 16 hex chars of sha256(text). */
export function shortHash(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text))).slice(0, 16);
}

/** `sha256(type + ":" + normalize(type, value))[0..16]`. Normalizes `value` itself, so raw input is fine. */
export function nodeId(type: NodeType, value: string): string {
  return shortHash(`${type}:${normalize(type, value)}`);
}

/** `sha256(sourceId + "|" + relation + "|" + targetId)[0..16]`. Direction matters. */
export function edgeId(sourceId: string, relation: Relation, targetId: string): string {
  return shortHash(`${sourceId}|${relation}|${targetId}`);
}
