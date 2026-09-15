/**
 * Step 35 — Settings -> Switch to Business account. Reachable only from
 * the Settings row that already hides itself once the account is
 * Business (see settings/index.tsx), but this screen still checks
 * `profile.accountType` itself and renders an inert "already switched"
 * state rather than assuming — a stale back-navigation or deep link could
 * otherwise land here after another tab already completed the switch.
 *
 * Deliberately lighter than DeleteAccountFlow's typed-word + password
 * ceremony: that flow guards against irrecoverable DATA LOSS, this one
 * guards against an irrecoverable but non-destructive SETTING change (see
 * src/utils/accountCapabilities.ts — Business is Personal plus the
 * ability to create Events, nothing is removed). A dedicated explanation
 * screen plus one ConfirmDialog beat — the same weight this app already
 * gives to Block (see src/app/(app)/user/[uid]/index.tsx) — is
 * proportionate; firestore.rules is what actually makes the transition
 * one-way (see its own `allow update` block on users/{uid}), not this UI.
 */
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { Colors, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { upgradeToBusinessAccount } from '@/services/userProfile';
import { isBusinessAccount } from '@/utils/accountCapabilities';

export default function BusinessAccountScreen() {
  const { user } = useAuth();
  const { profile, refreshProfile } = useProfile();

  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleConfirmSwitch = async () => {
    if (!user || isSubmitting) return;
    setIsSubmitting(true);
    setErrorMessage(null);
    const result = await upgradeToBusinessAccount(user.uid);
    setIsSubmitting(false);
    if (!result.ok) {
      setIsConfirmOpen(false);
      setErrorMessage(result.message);
      return;
    }
    setIsConfirmOpen(false);
    await refreshProfile();
    router.back();
  };

  if (isBusinessAccount(profile)) {
    return (
      <HeaderScreenLayout title="Business account">
        <Text style={styles.title}>You&apos;re already on a Business account</Text>
        <Text style={styles.body}>There&apos;s nothing else to do here — you can already create Events.</Text>
      </HeaderScreenLayout>
    );
  }

  return (
    <HeaderScreenLayout title="Business account">
      <Text style={styles.title}>Switch to a Business account</Text>

      <View style={styles.copyBlock}>
        <Text style={styles.sectionLabel}>What changes:</Text>
        <Bullet text="You'll be able to create Events" />
      </View>

      <View style={styles.copyBlock}>
        <Text style={styles.sectionLabel}>What stays the same:</Text>
        <Bullet text="Your profile, Posts, Activities, followers and everything else" />
      </View>

      <Text style={styles.permanentNotice}>
        This can&apos;t be undone. Once you switch, there&apos;s no way to change this account back to Personal.
      </Text>

      {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}

      <Button label="Switch to Business account" onPress={() => setIsConfirmOpen(true)} disabled={isSubmitting} />

      <ConfirmDialog
        visible={isConfirmOpen}
        title="Switch to Business account?"
        message="This can't be undone — you won't be able to switch back to a Personal account. You'll be able to create Events; everything else stays the same."
        confirmLabel="Switch account"
        isSubmitting={isSubmitting}
        onConfirm={handleConfirmSwitch}
        onCancel={() => setIsConfirmOpen(false)}
      />
    </HeaderScreenLayout>
  );
}

function Bullet({ text }: { text: string }) {
  return (
    <View style={styles.bulletRow}>
      <View style={styles.bulletDot} />
      <Text style={styles.bulletText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  title: {
    color: Colors.text,
    fontSize: 22,
    fontWeight: '800',
  },
  body: {
    color: Colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  copyBlock: {
    gap: Spacing.xs,
  },
  sectionLabel: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 2,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
  },
  bulletDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: Colors.textSecondary,
    marginTop: 7,
  },
  bulletText: {
    flex: 1,
    color: Colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  permanentNotice: {
    color: Colors.error,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },
  error: {
    color: Colors.error,
    fontSize: 13,
  },
});
