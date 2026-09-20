// Single module for all discovery/draft bounds. Limits are reported,
// never silently claimed as full analysis.

export interface Limits {
  /** Max entries visited during the bounded nested search. */
  maxFiles: number;
  /** Max bytes read from any single file. */
  maxFileBytes: number;
  /** Max total bytes read during one inspection. */
  maxTotalBytes: number;
  /** Max directory depth below the root for targeted searches. */
  maxDepth: number;
  /** Timeout for each read-only git subprocess call. */
  gitTimeoutMs: number;
  /** Max bytes of git subprocess output kept. */
  maxOutputBytes: number;
  /** Max bytes of a proposed instruction file. */
  maxProposedBytes: number;
  /** Max bullets in the deterministic root draft. */
  maxBullets: number;
  /** Max words of written root-draft bullets; the rest is copy-only overflow. */
  maxDraftWords: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxFiles: 200,
  maxFileBytes: 32 * 1024,
  maxTotalBytes: 512 * 1024,
  maxDepth: 4,
  gitTimeoutMs: 3000,
  maxOutputBytes: 64 * 1024,
  maxProposedBytes: 32 * 1024,
  maxBullets: 12,
  maxDraftWords: 200,
};
