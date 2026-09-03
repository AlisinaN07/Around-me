import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { reportContent, reportMessage, reportReel, reportUser } from '@/services/reports';
import { REPORT_DETAILS_MAX_LENGTH, REPORT_REASON_OPTIONS, type ReportReason } from '@/types/report';

export type ReportTarget =
  | { type: 'user'; targetUid: string }
  | { type: 'content'; contentId: string }
  | { type: 'message'; conversationId: string; messageId: string }
  | { type: 'reel'; reelId: string };

type ReportModalProps = {
  visible: boolean;
  onClose: () => void;
  reporterUid: string;
  target: ReportTarget;
};

type SubmitStatus = 'idle' | 'submitting' | 'submitted' | 'error';

/**
 * One reusable report flow for user/content/message targets — see
 * src/services/reports.ts. Never fakes a moderation outcome: success just
 * confirms the report was recorded, nothing about what happens next.
 */
export function ReportModal({ visible, onClose, reporterUid, target }: ReportModalProps) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [status, setStatus] = useState<SubmitStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resets the form fresh every time this modal is reopened for a (possibly different) target.
      setReason(null);
      setDetails('');
      setStatus('idle');
      setErrorMessage(null);
    }
  }, [visible]);

  const handleSubmit = async () => {
    if (!reason || status === 'submitting') return;
    setStatus('submitting');
    setErrorMessage(null);
    const result =
      target.type === 'user'
        ? await reportUser(reporterUid, target.targetUid, reason, details)
        : target.type === 'content'
          ? await reportContent(reporterUid, target.contentId, reason, details)
          : target.type === 'reel'
            ? await reportReel(reporterUid, target.reelId, reason, details)
            : await reportMessage(reporterUid, target.conversationId, target.messageId, reason, details);
    if (!result.ok) {
      setStatus('error');
      setErrorMessage(result.message);
      return;
    }
    setStatus('submitted');
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <Text style={styles.title}>Report</Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button">
            <Text style={styles.close}>Close</Text>
          </Pressable>
        </View>

        {status === 'submitted' ? (
          <View style={styles.successPanel}>
            <Ionicons name="checkmark-circle-outline" size={32} color={Colors.success} />
            <Text style={styles.successTitle}>Report submitted</Text>
            <Text style={styles.successBody}>Thanks for letting us know.</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            <Text style={styles.sectionLabel}>Why are you reporting this?</Text>
            {REPORT_REASON_OPTIONS.map((option) => {
              const selected = reason === option.id;
              return (
                <Pressable
                  key={option.id}
                  onPress={() => setReason(option.id)}
                  style={styles.reasonRow}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                >
                  <Ionicons
                    name={selected ? 'radio-button-on' : 'radio-button-off'}
                    size={18}
                    color={selected ? Colors.accent : Colors.textSecondary}
                  />
                  <Text style={styles.reasonText}>{option.label}</Text>
                </Pressable>
              );
            })}

            <Text style={styles.sectionLabel}>Additional details (optional)</Text>
            <TextInput
              style={styles.detailsInput}
              value={details}
              onChangeText={setDetails}
              placeholder="Add any helpful context…"
              placeholderTextColor={Colors.textSecondary}
              multiline
              maxLength={REPORT_DETAILS_MAX_LENGTH}
            />

            {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}

            <Button label="Submit" onPress={handleSubmit} disabled={!reason} loading={status === 'submitting'} />
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
  },
  title: {
    color: Colors.text,
    fontSize: 18,
    fontWeight: '700',
  },
  close: {
    color: Colors.accent,
    fontSize: 15,
    fontWeight: '600',
  },
  body: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.xxl,
    gap: Spacing.sm,
  },
  sectionLabel: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginTop: Spacing.md,
    marginBottom: 2,
  },
  reasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.sm,
  },
  reasonText: {
    color: Colors.text,
    fontSize: 15,
  },
  detailsInput: {
    minHeight: 80,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    color: Colors.text,
    fontSize: 15,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    textAlignVertical: 'top',
  },
  errorText: {
    color: Colors.error,
    fontSize: 13,
  },
  successPanel: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.xl,
  },
  successTitle: {
    color: Colors.text,
    fontSize: 17,
    fontWeight: '700',
  },
  successBody: {
    color: Colors.textSecondary,
    fontSize: 14,
    textAlign: 'center',
  },
});
