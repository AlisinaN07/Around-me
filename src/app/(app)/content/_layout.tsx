import { Stack } from 'expo-router';

/** Content detail screen — a stack screen above the tab bar, not a tab itself. */
export default function ContentStackLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
