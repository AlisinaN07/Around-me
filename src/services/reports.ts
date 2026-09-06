/**
 * Reports — reports/{reportId}. Private moderation records: only the
 * reporter may ever read their own submitted report (see firestore.rules)
 * — there is no moderation UI yet. UI code should only ever import from
 * here, never talk to Firestore directly for reports.
 */

import { doc, getDoc, serverTimestamp, setDoc, type WithFieldValue } from 'firebase/firestore';

import { fetchContentById } from '@/services/content';
import { firestore } from '@/services/firestore';
import { fetchPublicProfile } from '@/services/publicProfile';
import { fetchReel } from '@/services/reels';
import { REPORT_DETAILS_MAX_LENGTH, type Report, type ReportReason } from '@/types/report';
import type { Message } from '@/types/message';

const REPORTS_COLLECTION = 'reports';

function reportRef(reportId: string) {
  return doc(firestore!, REPORTS_COLLECTION, reportId);
}

function userReportId(reporterUid: string, targetUid: string): string {
  return `user_${reporterUid}_${targetUid}`;
}
function contentReportId(reporterUid: string, contentId: string): string {
  return `content_${reporterUid}_${contentId}`;
}
function messageReportId(reporterUid: string, messageId: string): string {
  return `message_${reporterUid}_${messageId}`;
}
function reelReportId(reporterUid: string, reelId: string): string {
  return `reel_${reporterUid}_${reelId}`;
}

function normalizeDetails(details: string | undefined): string | null {
  const trimmed = details?.trim();
  if (!trimmed) return null;
  return trimmed.length > REPORT_DETAILS_MAX_LENGTH ? trimmed.slice(0, REPORT_DETAILS_MAX_LENGTH) : trimmed;
}

/** Every newly-created report starts in this moderation state — see firestore.rules' isValidReportBase, which requires exactly this on create. */
const INITIAL_MODERATION_FIELDS = { status: 'open', moderatedAt: null, moderatedByUid: null } as const;

export type ReportError = 'not-configured' | 'invalid-input' | 'not-found' | 'unknown';
export type ReportResult = { ok: true; alreadyReported: boolean } | { ok: false; error: ReportError; message: string };

async function submitReport(reportId: string, data: WithFieldValue<Report>): Promise<ReportResult> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  const existing = await getDoc(reportRef(reportId));
  if (existing.exists()) {
    return { ok: true, alreadyReported: true };
  }
  try {
    await setDoc(reportRef(reportId), data);
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't submit your report." };
  }
  return { ok: true, alreadyReported: false };
}

export async function reportUser(reporterUid: string, targetUid: string, reason: ReportReason, details?: string): Promise<ReportResult> {
  if (reporterUid === targetUid) {
    return { ok: false, error: 'invalid-input', message: "You can't report yourself." };
  }
  const targetProfile = await fetchPublicProfile(targetUid);
  if (!targetProfile) {
    return { ok: false, error: 'not-found', message: "Couldn't find that user." };
  }
  const reportId = userReportId(reporterUid, targetUid);
  return submitReport(reportId, {
    reportId,
    reporterUid,
    targetType: 'user',
    targetUid,
    contentId: null,
    conversationId: null,
    messageId: null,
    reelId: null,
    reason,
    details: normalizeDetails(details),
    createdAt: serverTimestamp(),
    ...INITIAL_MODERATION_FIELDS,
  });
}

export async function reportContent(reporterUid: string, contentId: string, reason: ReportReason, details?: string): Promise<ReportResult> {
  const content = await fetchContentById(contentId);
  if (!content || content.status !== 'published') {
    return { ok: false, error: 'not-found', message: "Couldn't find that." };
  }
  if (content.authorUid === reporterUid) {
    return { ok: false, error: 'invalid-input', message: "You can't report your own post." };
  }
  const reportId = contentReportId(reporterUid, contentId);
  return submitReport(reportId, {
    reportId,
    reporterUid,
    targetType: 'content',
    targetUid: content.authorUid,
    contentId,
    conversationId: null,
    messageId: null,
    reelId: null,
    reason,
    details: normalizeDetails(details),
    createdAt: serverTimestamp(),
    ...INITIAL_MODERATION_FIELDS,
  });
}

export async function reportReel(reporterUid: string, reelId: string, reason: ReportReason, details?: string): Promise<ReportResult> {
  const reel = await fetchReel(reelId);
  if (!reel || reel.status !== 'published') {
    return { ok: false, error: 'not-found', message: "Couldn't find that post." };
  }
  if (reel.authorUid === reporterUid) {
    return { ok: false, error: 'invalid-input', message: "You can't report your own post." };
  }
  const reportId = reelReportId(reporterUid, reelId);
  return submitReport(reportId, {
    reportId,
    reporterUid,
    targetType: 'reel',
    targetUid: reel.authorUid,
    contentId: null,
    conversationId: null,
    messageId: null,
    reelId,
    reason,
    details: normalizeDetails(details),
    createdAt: serverTimestamp(),
    ...INITIAL_MODERATION_FIELDS,
  });
}

export async function reportMessage(
  reporterUid: string,
  conversationId: string,
  messageId: string,
  reason: ReportReason,
  details?: string
): Promise<ReportResult> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  const messageSnapshot = await getDoc(doc(firestore, 'conversations', conversationId, 'messages', messageId));
  if (!messageSnapshot.exists()) {
    return { ok: false, error: 'not-found', message: "Couldn't find that message." };
  }
  const message = messageSnapshot.data() as Message;
  if (message.senderUid === reporterUid) {
    return { ok: false, error: 'invalid-input', message: "You can't report your own message." };
  }
  const reportId = messageReportId(reporterUid, messageId);
  return submitReport(reportId, {
    reportId,
    reporterUid,
    targetType: 'message',
    targetUid: message.senderUid,
    contentId: null,
    conversationId,
    messageId,
    reelId: null,
    reason,
    details: normalizeDetails(details),
    createdAt: serverTimestamp(),
    ...INITIAL_MODERATION_FIELDS,
  });
}
