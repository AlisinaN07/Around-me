import { Image, StyleSheet, Text, View } from 'react-native';

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
 */
export function Avatar({ name, photoURL, size = 72 }: { name: string; photoURL?: string; size?: number }) {
  if (photoURL) {
    return (
      <Image
        source={{ uri: photoURL }}
        style={[styles.circle, { width: size, height: size, borderRadius: size / 2 }]}
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
