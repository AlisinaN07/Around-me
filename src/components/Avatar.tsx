import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';

function getInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return '?';
  }
  const first = words[0]?.charAt(0) ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.charAt(0) ?? '') : '';
  return (first + last).toUpperCase();
}

/**
 * `photoURL` is optional and, when present, must be a non-empty, already-
 * resolved HTTPS download URL (see UserProfile.photoURL's own doc comment)
 * — never a bare Storage path. Most call sites don't have one to pass yet
 * (their display name comes from a denormalized field on some other
 * document — a notification, a comment, a conversation — not a fetched
 * profile), and simply keep rendering the initials circle exactly as
 * before; only call sites that already hold a real UserProfile/
 * PublicProfile (Edit Profile, the own/public Profile header) pass it.
 *
 * Perf pass — `expo-image` instead of React Native's own `Image`: this is
 * the single highest-leverage image surface in the app (the same
 * `photoURL` is re-rendered across Reels, comments, Inbox, profiles,
 * followers/following — everywhere an author or user shows up), so a
 * real memory+disk cache here means the SAME photo renders instantly on
 * every one of those surfaces after the first load, this session AND
 * after an app restart, instead of each mount depending on the OS's own
 * opaque HTTP cache. `cachePolicy="memory-disk"` — the URL itself is
 * already a stable, unique key (see photoURL's own doc comment: a real
 * download URL, not a path that could collide) — no custom cache-key
 * needed. `contentFit="cover"` matches the plain `<Image>`'s own default
 * `resizeMode` (unset = 'cover'), so this is a behavior-neutral swap —
 * still fills the circle exactly as before, cropping rather than
 * letterboxing.
 */
export function Avatar({ name, photoURL, size = 72 }: { name: string; photoURL?: string; size?: number }) {
  if (photoURL) {
    return (
      <Image
        source={{ uri: photoURL }}
        style={[styles.circle, { width: size, height: size, borderRadius: size / 2 }]}
        contentFit="cover"
        cachePolicy="memory-disk"
        accessibilityLabel={`${name}'s profile photo`}
      />
    );
  }

  return (
    <View style={[styles.circle, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[styles.initials, { fontSize: size * 0.36 }]}>{getInitials(name)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.accent,
  },
  initials: {
    color: Colors.background,
    fontWeight: '800',
  },
});
