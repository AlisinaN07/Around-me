import { Stack } from 'expo-router';

/** Public profile + followers/following lists — stack screens above the tab bar, not tabs. */
export default function UserStackLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
