import { Stack } from 'expo-router';

/** Place detail screen — a stack screen above the tab bar, not a tab itself. */
export default function PlaceStackLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
