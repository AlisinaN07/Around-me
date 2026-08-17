import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, type StyleProp, type ViewStyle } from 'react-native';

type AuthorLinkProps = {
  uid: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
};

/**
 * Thin tappable wrapper that opens a public profile — used anywhere an
 * author/participant/commenter's name is shown. Safe to nest inside another
 * Pressable (e.g. a ContentCard that opens content detail on its own tap):
 * stopPropagation keeps the outer card's onPress from also firing, and
 * accessibilityRole="link" (rather than "button") keeps React Native Web
 * from rendering a <button> here — nested inside ContentCard's own <button>,
 * that would be invalid HTML and can break click routing in real browsers.
 */
export function AuthorLink({ uid, children, style }: AuthorLinkProps) {
  return (
    <Pressable
      onPress={(event) => {
        event.stopPropagation();
        router.push(`/user/${uid}`);
      }}
      style={style}
      hitSlop={4}
      accessibilityRole="link"
      accessibilityLabel="View profile"
    >
      {children}
    </Pressable>
  );
}
