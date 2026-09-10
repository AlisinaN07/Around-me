/**
 * Step 34.3 — the account-deletion flow, shared by two entry points:
 *  - mode="initial": Settings → Delete account (src/app/(app)/settings/delete-account.tsx),
 *    a fresh destructive decision — explanation, DELETE confirmation, password.
 *  - mode="recovery": src/app/deletion-recovery.tsx, reached automatically
 *    when a prior attempt was interrupted after reauthentication (a local
 *    aroundme.deletionPending.{uid} marker is still set — see
 *    src/utils/deletionPending.ts and src/app/_layout.tsx). No DELETE
 *    retyping here: that destructive decision was already made: only a
 *    fresh password (Firebase's "recent login" requirement may have
 *    expired) and a retry of backend/Auth deletion.
 *
 * LOCKED ORDER (do not reorder): confirm -> reauthenticate -> call the
 * trusted backend (deleteMyAccountData) -> delete the Firebase Auth user.
 * Reauthentication happens BEFORE the backend call specifically so that if
 * Auth deletion is the step that fails, it fails on a fresh login, not a
 * stale one — and backend cleanup never runs on a session we can't finish
 * closing out. See README "Account deletion" for the full rationale.
 */
import { Ionicons } from '@expo/vector-icons';
import { FirebaseError } from 'firebase/app';
import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { FormField } from '@/components/FormField';
import { SwipeBackEdge } from '@/components/SwipeBackEdge';
import { Colors, Spacing, Typography } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { clearStoredActiveCityForUid } from '@/providers/CityProvider';
import { deleteMyAccountData } from '@/services/accountDeletion';
import { isBusinessAccount } from '@/utils/accountCapabilities';
import { clearDeletionPending, setDeletionPending } from '@/utils/deletionPending';
import { setPostDeletionNotice } from '@/utils/postDeletionNotice';

const DELETE_CONFIRMATION_WORD = 'DELETE';

type Phase =
  | 'form'
  | 'reauthenticating'
  | 'removing-data'
  | 'backend-failed'
  | 'deleting-account'
  | 'auth-delete-failed';

function firebaseAuthErrorCode(error: unknown): string | null {
  return error instanceof FirebaseError ? error.code : null;
}

function reauthErrorMessage(error: unknown): string {
  const code = firebaseAuthErrorCode(error);
  if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
    return 'Incorrect password.';
  }
  if (code === 'auth/too-many-requests') {
    return 'Too many attempts. Please wait a moment and try again.';
  }
  if (code === 'auth/network-request-failed') {
    return 'Network problem. Check your connection and try again.';
  }
  return "Couldn't verify your password. Please try again.";
}

export function DeleteAccountFlow({ mode }: { mode: 'initial' | 'recovery' }) {
  const { user, reauthenticateWithPassword, deleteCurrentUser } = useAuth();
  const { profile } = useProfile();

  const [phase, setPhase] = useState<Phase>('form');
  const [confirmText, setConfirmText] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Section 11 — an email/password account with no email is a data
  // inconsistency this screen can't safely proceed past; checked once
  // up front rather than only discovered at submit time.
  const hasEmail = !!user?.email;

  const isFormLocked = phase !== 'form' && phase !== 'backend-failed' && phase !== 'auth-delete-failed';
  const canGoBack = mode === 'initial' && phase === 'form';

  async function runBackendThenAuthDelete() {
    if (!user) return;
    setPhase('removing-data');
    const result = await deleteMyAccountData();
    if (!result.ok) {
      setPhase('backend-failed');
      return;
    }

    setPhase('deleting-account');
    try {
      await deleteCurrentUser();
    } catch {
      // Data is gone, Auth is not — the local marker MUST stay set so a
      // restart routes back here instead of onboarding (see
      // src/app/_layout.tsx), never cleared on this path.
      setPhase('auth-delete-failed');
      return;
    }

    // Full success. These are plain AsyncStorage writes, not tied to this
    // component's mount state, so they complete even though the auth-state
    // change this triggers may unmount the screen immediately after.
    await Promise.allSettled([
      clearDeletionPending(user.uid),
      clearStoredActiveCityForUid(user.uid),
      setPostDeletionNotice(),
    ]);
  }

  async function handleReauthenticateAndDelete() {
    if (!user || isFormLocked) return;
    if (!hasEmail) return;

    setErrorMessage(null);
    setPhase('reauthenticating');
    try {
      await reauthenticateWithPassword(password);
    } catch (error) {
      setPassword('');
      setPhase('form');
      setErrorMessage(reauthErrorMessage(error));
      return;
    }
    setPassword('');

    // Reauthentication succeeded — from here on, deletion proceeds. Set the
    // local recovery marker before the very first destructive backend call.
    await setDeletionPending(user.uid);
    await runBackendThenAuthDelete();
  }

  const canSubmitInitial =
    hasEmail && confirmText === DELETE_CONFIRMATION_WORD && password.length > 0 && phase === 'form';
  const canSubmitRecoveryOrRetry = hasEmail && password.length > 0 && (phase === 'form' || phase === 'auth-delete-failed');

  if (!hasEmail) {
    return (
      <Screen canGoBack={mode === 'initial'}>
        <Text style={styles.title}>Can&apos;t delete this account automatically</Text>
        <Text style={styles.body}>
          Your account doesn&apos;t have an email on file, so we can&apos;t verify your password before deleting it.
          Please contact support to finish deleting this account.
        </Text>
      </Screen>
    );
  }

  if (phase === 'reauthenticating' || phase === 'removing-data' || phase === 'deleting-account') {
    const progressText =
      phase === 'reauthenticating'
        ? 'Verifying your password…'
        : phase === 'removing-data'
          ? 'Removing your Around Me data…'
          : 'Deleting account…';
    return (
      <Screen canGoBack={false}>
        <View style={styles.progressWrap}>
          <ActivityIndicator size="large" color={Colors.accent} />
          <Text style={styles.progressText}>{progressText}</Text>
        </View>
      </Screen>
    );
  }

  if (phase === 'backend-failed') {
    return (
      <Screen canGoBack={false}>
        <Text style={styles.title}>We couldn&apos;t finish deleting your account</Text>
        <Text style={styles.body}>
          Nothing else was affected. It&apos;s safe to try again — your account will remain in this deletion process
          until it succeeds.
        </Text>
        <Button label="Try again" variant="destructive" onPress={runBackendThenAuthDelete} />
      </Screen>
    );
  }

  if (phase === 'auth-delete-failed') {
    return (
      <Screen canGoBack={false}>
        <Text style={styles.title}>Almost done</Text>
        <Text style={styles.body}>
          Your Around Me data has been removed, but we couldn&apos;t finish deleting your login account. Enter your
          password again to finish.
        </Text>
        <FormField
          label="Password"
          value={password}
          onChangeText={setPassword}
          placeholder="Your password"
          secureToggle
          textContentType="password"
          autoComplete="password"
        />
        {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
        <Button
          label="Finish deleting"
          variant="destructive"
          onPress={handleReauthenticateAndDelete}
          disabled={!canSubmitRecoveryOrRetry}
        />
      </Screen>
    );
  }

  // phase === 'form'
  if (mode === 'recovery') {
    return (
      <Screen canGoBack={false}>
        <Text style={styles.title}>Finish deleting your account</Text>
        <Text style={styles.body}>
          A previous account deletion didn&apos;t finish. Enter your password to continue — no new data will be
          removed beyond what you already confirmed.
        </Text>
        <FormField
          label="Password"
          value={password}
          onChangeText={setPassword}
          placeholder="Your password"
          secureToggle
          textContentType="password"
          autoComplete="password"
        />
        {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
        <Button
          label="Continue deleting"
          variant="destructive"
          onPress={handleReauthenticateAndDelete}
          disabled={!canSubmitRecoveryOrRetry}
        />
      </Screen>
    );
  }

  const isBusiness = isBusinessAccount(profile);

  return (
    <Screen canGoBack={canGoBack}>
      <Text style={styles.title}>Delete account</Text>

      <View style={styles.copyBlock}>
        <Text style={styles.sectionLabel}>This will delete:</Text>
        <Bullet text="Your profile and username" />
        <Bullet text="Your Posts" />
        <Bullet text="Your Activities" />
        {isBusiness ? <Bullet text="Your published Events" /> : null}
        <Bullet text="Your follows and other social interactions" />
      </View>

      <View style={styles.copyBlock}>
        <Text style={styles.sectionLabel}>This will NOT delete:</Text>
        <Bullet text="Messages you've already sent may remain visible in other people's conversations" />
        <Bullet text="Reports are retained for safety and moderation history" />
      </View>

      <Text style={styles.permanentNotice}>
        This is permanent. Once deletion completes, your account and content can&apos;t be restored — there is no
        temporary deactivation and no recovery window.
      </Text>

      <FormField
        label={`Type ${DELETE_CONFIRMATION_WORD} to confirm`}
        value={confirmText}
        onChangeText={setConfirmText}
        placeholder={DELETE_CONFIRMATION_WORD}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
      />

      <FormField
        label="Current password"
        value={password}
        onChangeText={setPassword}
        placeholder="Your password"
        secureToggle
        textContentType="password"
        autoComplete="password"
      />

      {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}

      <Button
        label="Delete my account"
        variant="destructive"
        onPress={handleReauthenticateAndDelete}
        disabled={!canSubmitInitial}
      />
    </Screen>
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

function Screen({ canGoBack, children }: { canGoBack: boolean; children: ReactNode }) {
  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      {/* Same handler Header's own back button calls, only when it's actually shown. */}
      {canGoBack ? <SwipeBackEdge onBack={() => router.back()} /> : null}
      <Header canGoBack={canGoBack} />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Header({ canGoBack }: { canGoBack: boolean }) {
  return (
    <View style={styles.header}>
      {canGoBack ? (
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backButton}
        >
          <Ionicons name="chevron-back" size={24} color={Colors.text} />
        </Pressable>
      ) : (
        <View style={styles.backButton} />
      )}
      <Text style={styles.headerTitle}>Delete account</Text>
      <View style={styles.backButton} />
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.sm,
  },
  backButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    color: Colors.text,
    ...Typography.cardTitle,
    fontSize: 17,
  },
  scrollContent: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xxl,
    gap: Spacing.lg,
  },
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
  progressWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: Spacing.xxl,
    gap: Spacing.md,
  },
  progressText: {
    color: Colors.textSecondary,
    fontSize: 14,
  },
});
