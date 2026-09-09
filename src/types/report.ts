import type { Timestamp } from 'firebase/firestore';

export type ReportTargetType = 'user' | 'content' | 'message' | 'reel' | 'reel_comment';

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
 * Step 39.1 moderation lifecycle. Every report is created 'open'; the only
 * transition a client can never make itself is client-triggered — status
 * only ever changes via a trusted, admin-claim-gated Cloud Function (see
 * functions/src/index.ts's dismissReport). 'resolved' is reserved for a
 * future moderation-removal callable — nothing in this step ever sets it.
 */
export type ReportStatus = 'open' | 'dismissed' | 'resolved';

/**
 * reports/{reportId} — a private moderation record, never readable by
 * anyone but the reporter (see firestore.rules). Report CAPTURE (this
 * type) and moderation ACTION (Step 39.1's dismissReport, and later
 * removal callables) are deliberately separate: normal client writes may
 * only ever create a report, never touch its moderation fields directly.
 *
 * reportId is deterministic per (reporterUid, target) so one reporter
 * can't spam duplicate reports for the same exact target — see
 * src/services/reports.ts for the exact ID scheme per targetType.
 *
 * Exactly one of (targetUid alone) / (contentId + targetUid) /
 * (conversationId + messageId + targetUid) / (reelId + targetUid) /
 * (reelId + commentId + targetUid) is populated depending on targetType;
 * the other ID fields stay null. Never include emails, GPS, private
 * settings, or message history beyond the one reported message.
 *
 * A Reel is reports/{reportId}'s own separate reference (reelId), not
 * contentId — reels/{reelId} is a separate root collection from
 * content/{contentId} (see src/types/reel.ts). A reported Reel COMMENT
 * carries both reelId and commentId — the comment is a subcollection
 * document, not addressable by commentId alone.
 *
 * status/moderatedAt/moderatedByUid are new in Step 39.1. Reports created
 * before this step have none of these fields — trusted backend reads must
 * treat a missing status as 'open' and missing moderatedAt/moderatedByUid
 * as null; existing report documents are never migrated to add them.
 * `commentId` is newer still — every report created before Reel comment
 * reporting existed simply doesn't have this key at all despite the type
 * claiming a string, same "missing means null" reasoning as the fields
 * above.
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
  commentId: string | null;
  reason: ReportReason;
  details: string | null;
  createdAt: Timestamp;
  status: ReportStatus;
  moderatedAt: Timestamp | null;
  moderatedByUid: string | null;
};
