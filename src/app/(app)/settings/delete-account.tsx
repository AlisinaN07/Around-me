import { DeleteAccountFlow } from '@/components/DeleteAccountFlow';

/** Settings → Delete account (Step 34.3) — a fresh destructive decision. See DeleteAccountFlow for the full state machine. */
export default function DeleteAccountScreen() {
  return <DeleteAccountFlow mode="initial" />;
}
