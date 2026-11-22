import { router } from 'expo-router';
import { Text, type StyleProp, type TextStyle } from 'react-native';

import { splitTextWithHashtags } from '@/utils/hashtags';

type HighlightedTextProps = {
  text: string;
  /** Base style for the plain-text portions — and the whole block's layout (numberOfLines, etc.), same as passing it directly to a plain <Text>. */
  style?: StyleProp<TextStyle>;
  /** Additional style merged onto just the "#hashtag" spans — typically an accent color. */
  hashtagStyle?: StyleProp<TextStyle>;
  numberOfLines?: number;
};

/**
 * Renders `text` with every "#hashtag" inside it as its own tappable
 * nested `<Text>` span — used anywhere a Reel caption is shown in full
 * (see src/components/ReelFeedItem.tsx). Plain text stays plain text;
 * only the hashtag spans navigate anywhere.
 *
 * Deliberately nested `<Text onPress={...}>` spans, not `Pressable`
 * wrappers: React Native Web renders a plain `<Text>` as a `<div>`/`<span>`
 * regardless of whether it has an `onPress`, never a real `<button>` the
 * way `accessibilityRole="button"` would (see EventCard.tsx's own doc
 * comment on that exact mechanism) — so this needs no "link" role trick
 * to avoid a nested-`<button>` hydration warning; there is no `<button>`
 * here to begin with, nested or otherwise.
 *
 * Navigates to /hashtag/[hashtag] — see that screen's own doc comment for
 * why it's a minimal placeholder today, not a full discovery page yet.
 */
export function HighlightedText({ text, style, hashtagStyle, numberOfLines }: HighlightedTextProps) {
  const segments = splitTextWithHashtags(text);

  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {segments.map((segment, index) =>
        segment.type === 'hashtag' ? (
          <Text
            key={index}
            style={hashtagStyle}
            onPress={(event) => {
              event.stopPropagation();
              router.push(`/hashtag/${encodeURIComponent(segment.normalized)}`);
            }}
            accessibilityRole="link"
            accessibilityLabel={`View #${segment.normalized}`}
          >
            #{segment.raw}
          </Text>
        ) : (
          <Text key={index}>{segment.value}</Text>
        )
      )}
    </Text>
  );
}
