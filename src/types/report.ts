import type { Timestamp } from 'firebase/firestore';

export type ReportTargetType = 'user' | 'content' | 'message' | 'reel';

export type ReportReason = 'spam' | 'harassment' | 'hate' | 'sexual' | 'violence' | 'scam' | 'other';

export const REPORT_REASON_OPTIONS: { id: ReportReason; label: string }[] = [
  { id: 'spam', label: 'Spam' },
  { id: 'harassment', label: 'Harassment' },
  { id: 'hate', label: 'Hate or abusive content' },
  { id: 'sexual', label: 'Sexual content' },
  { id: 'violence', label: 'Violence' },
  { id: 'scam', label: 'Scam' },
  { id: 'other', label: 'Other' },
];

export const REPORT_DETAILS_MAX_LENGTH = 1000;

/**
 * reports/{reportId} — a private moderation record, never readable by
 * anyone but the reporter (see firestore.rules). There is no moderation
 * UI yet in Step 17 — reports are stored securely for future
 * admin/moderation tooling.
 *
 * reportId is deterministic per (reporterUid, target) so one reporter
 * can't spam duplicate reports for the same exact target — see
 * src/services/reports.ts for the exact ID scheme per targetType.
 *
 * Exactly one of (targetUid alone) / (contentId + targetUid) /
 * (conversationId + messageId + targetUid) / (reelId + targetUid) is
 * populated depending on targetType; the other ID fields stay null. Never
 * include emails, GPS, private settings, or message history beyond the
 * one reported message.
 *
 * A Reel is reports/{reportId}'s own separate reference (reelId), not
 * contentId — reels/{reelId} is a separate root collection from
 * content/{contentId} (see src/types/reel.ts).
 */
export type Report = {
  reportId: string;
  reporterUid: string;
  targetType: ReportTargetType;
  targetUid: string | null;
  contentId: string | null;
  conversationId: string | null;
  messageId: string | null;
  reelId: string | null;
  reason: ReportReason;
  details: string | null;
  createdAt: Timestamp;
};
