import { Stack } from 'expo-router';

/** Post/Activity/Event creation forms — stack screens above the tab bar, not tabs themselves. */
export default function CreateStackLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
