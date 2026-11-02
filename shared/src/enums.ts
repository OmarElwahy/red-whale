// Enums from docs/contract.md (§3, §4) and docs/architecture.md (§4).

export const CONTRACT_VERSION = 1;

export const NODE_TYPES = [
  'domain',
  'subdomain',
  'ip',
  'port',
  'url',
  'technology',
  'vulnerability',
  'email',
  'secret',
  'certificate',
  'leak',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const RELATION_TYPES = [
  'has_subdomain',
  'resolves_to',
  'has_port',
  'serves',
  'has_url',
  'uses_technology',
  'has_vulnerability',
  'has_certificate',
  'has_email',
  'has_secret',
  'found_in_leak',
] as const;
export type Relation = (typeof RELATION_TYPES)[number];

/** Allowed parent → child node types for each relation (contract §4). */
export const RELATIONS: Record<Relation, { parents: readonly NodeType[]; children: readonly NodeType[] }> = {
  has_subdomain: { parents: ['domain'], children: ['subdomain'] },
  resolves_to: { parents: ['domain', 'subdomain'], children: ['ip'] },
  has_port: { parents: ['ip'], children: ['port'] },
  serves: { parents: ['port', 'subdomain', 'domain'], children: ['url'] },
  has_url: { parents: ['url'], children: ['url'] },
  uses_technology: { parents: ['url', 'port'], children: ['technology'] },
  has_vulnerability: { parents: ['url', 'port', 'technology', 'subdomain', 'ip'], children: ['vulnerability'] },
  has_certificate: { parents: ['port', 'subdomain'], children: ['certificate'] },
  has_email: { parents: ['domain', 'subdomain', 'url'], children: ['email'] },
  has_secret: { parents: ['url'], children: ['secret'] },
  found_in_leak: { parents: ['email'], children: ['leak'] },
};

/** Ordered from lowest to highest. */
export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SCAN_STATUSES = ['success', 'partial', 'failed'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const CONFIDENCE_LEVELS = ['discovered', 'corroborated', 'verified'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

/** Edge confidence is only ever computed (1 tool / 2+ tools); there is no analyst-verified edge. */
export const EDGE_CONFIDENCE_LEVELS = ['discovered', 'corroborated'] as const;
export type EdgeConfidence = (typeof EDGE_CONFIDENCE_LEVELS)[number];

/** Why a scan observed a node: it reported it as a finding, or only named it as a finding's parent. */
export const OBSERVATION_ROLES = ['finding', 'parent'] as const;
export type ObservationRole = (typeof OBSERVATION_ROLES)[number];

export const TAGS = ['interesting', 'checked', 'ignored'] as const;
export type Tag = (typeof TAGS)[number];

/** What an analyst delete names: one node, or a group (its members under the request's filters). */
export const DELETION_KINDS = ['node', 'group'] as const;
export type DeletionKind = (typeof DELETION_KINDS)[number];

/** `node`: only the named node(s); `subtree`: with everything below them that has no other parent. */
export const DELETION_MODES = ['node', 'subtree'] as const;
export type DeletionMode = (typeof DELETION_MODES)[number];

/**
 * The tool name of nodes and links the analyst adds by hand (POST /api/nodes). Reserved: ingest refuses files that
 * use it, and its observations never count toward source_count / corroboration.
 */
export const MANUAL_TOOL = 'manual';
