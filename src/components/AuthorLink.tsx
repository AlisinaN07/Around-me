import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, type StyleProp, type ViewStyle } from 'react-native';

import { useAuth } from '@/hooks/useAuth';
import { trackContentInteraction } from '@/services/recommendations/interactions';

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
 *
 * Step 2, second pass — this is the ONE shared place a profile actually
 * gets opened from content (feeds, comments, content cards, everywhere
 * else this wraps a name), so it's the one wiring point for the
 * `profile_open` recommendation signal rather than duplicating a tracking
 * call at every call site. Skipped for a self-tap (opening your own
 * profile says nothing about creator affinity) and when signed out.
 */
export function AuthorLink({ uid, children, style }: AuthorLinkProps) {
  const { user } = useAuth();

  return (
    <Pressable
      onPress={(event) => {
        event.stopPropagation();
        if (user && user.uid !== uid) {
          trackContentInteraction({
            userId: user.uid,
            contentId: uid,
            contentType: 'content',
            action: 'profile_open',
            categoryId: '',
            creatorId: uid,
            cityKey: '',
            countryCode: '',
          }).catch(() => {});
        }
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
