// Data model shared by the server and the web app. Keep this file free of runtime dependencies.

export type FieldState =
  | 'extracted' // found by recognition, readings agree
  | 'needs_review' // found, but something specific is uncertain (see reasons)
  | 'not_found' // nothing found; does NOT prove the card lacks it
  | 'failed' // processing failed for this card
  | 'user_corrected' // the current value was entered/approved by the user
  | 'enriched'; // value came from optional enrichment (e.g. confirmed LinkedIn search result)

export type FieldSource = 'ocr' | 'qr' | 'user' | 'enrichment' | 'import';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FieldMeta {
  state: FieldState;
  source: FieldSource;
  /** What the machine suggested most recently (kept even after a user correction). */
  machineValue?: string;
  /** Recognition confidence reported by the model (not a calibrated probability). */
  confidence?: number;
  lineIds?: string[];
  /** Evidence region in the processed card image. */
  box?: Box;
  reasons?: string[];
  alternatives?: string[];
}

export interface TextField {
  value: string;
  meta: FieldMeta;
}

export type PhoneLabel = 'mobile' | 'office' | 'direct' | 'fax' | 'home' | 'phone' | 'other';
export type EmailLabel = 'work' | 'general' | 'personal' | 'other';

export interface MultiValue {
  id: string;
  /** Exactly as printed/entered (original formatting preserved). */
  value: string;
  /** For matching/search only (lower-cased email, digits-only phone with leading +). */
  normalized: string;
  label: string;
  primary: boolean;
  meta: FieldMeta;
}

export interface LinkedInCandidate {
  url: string;
  title: string;
  snippet: string;
  source: string;
  foundAt: string;
}

export interface LinkedInInfo {
  /** Only a URL printed on the card / in its QR code, or one the user explicitly confirmed. */
  url: string;
  meta: FieldMeta;
  candidates: LinkedInCandidate[];
  searchedAt?: string;
}

export type ContactStatus = 'new' | 'follow_up' | 'connected';
export type RecordState = 'draft' | 'saved' | 'skipped';

export interface Contact {
  id: string;
  state: RecordState;
  status: ContactStatus;
  name: TextField;
  /** Post-nominal letters printed after the name (e.g. "PE, CEM"), kept separate so the name stays clean. */
  credentials: TextField;
  company: TextField;
  title: TextField;
  address: TextField;
  emails: MultiValue[];
  phones: MultiValue[];
  websites: MultiValue[];
  linkedin: LinkedInInfo;
  event: string;
  tags: string[];
  notes: string;
  followUp: string; // YYYY-MM-DD or ''
  cardIds: string[]; // source card images (front first)
  batchId: string | null;
  /** Recognized text (all lines, reading order) for search and verification. */
  ocrText: string;
  extractorVersion: string;
  createdAt: string;
  updatedAt: string;
  savedAt: string | null;
  /** Bumped on every write; clients send it back to avoid overwriting newer edits. */
  revision: number;
  /** Contact ids this one was merged from (audit trail). */
  mergedFrom: string[];
}

export type CardSide = 'front' | 'back';

export interface CardImage {
  id: string;
  contactId: string | null;
  side: CardSide;
  originalName: string;
  originalMime: string;
  originalBytes: number;
  width: number;
  height: number;
  processedWidth: number;
  processedHeight: number;
  engineVersion: string;
  processedAt: string | null;
  createdAt: string;
}

export type BatchItemStatus = 'queued' | 'processing' | 'ready' | 'needs_attention' | 'saved' | 'skipped' | 'failed';

export interface BatchItem {
  id: string;
  batchId: string;
  position: number;
  cardId: string;
  contactId: string | null;
  fileName: string;
  status: BatchItemStatus;
  error: string | null;
  attempts: number;
  durationMs: number | null;
  updatedAt: string;
}

export interface Batch {
  id: string;
  kind: 'batch' | 'single';
  label: string;
  event: string;
  tags: string[];
  paused: boolean;
  discardedAt: string | null;
  createdAt: string;
  items: BatchItem[];
}

export interface OcrLineDTO {
  id: string;
  text: string;
  confidence: number;
  box: Box;
  disputed: boolean;
  readings: { text: string; confidence: number; source: string }[];
}

export interface ServerInfo {
  version: string;
  engine: string;
  processing: 'local-computer';
  storagePath: string;
  limits: { maxFiles: number; maxFileBytes: number; maxBatchBytes: number };
  lanUrls: string[];
  https: boolean;
  linkedinSearch: { available: boolean; provider: string | null };
  modelStatus: 'ready' | 'loading' | 'error';
  modelError?: string;
  counts: { saved: number; drafts: number; queued: number };
}
