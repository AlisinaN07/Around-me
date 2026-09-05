import { DeleteAccountFlow } from '@/components/DeleteAccountFlow';

/**
 * Step 34.3 — reached automatically (never navigated to directly) when the
 * root layout finds a local aroundme.deletionPending.{uid} marker for the
 * signed-in uid — see src/app/_layout.tsx. Lives outside the (app)/
 * (onboarding)/(auth) groups since it must override all three: normal app
 * access and onboarding are both unsafe while a deletion may be mid-flight
 * (see DeleteAccountFlow's file header).
 */
export default function DeletionRecoveryScreen() {
  return <DeleteAccountFlow mode="recovery" />;
}
