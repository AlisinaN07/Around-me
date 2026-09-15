import { useMemo } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';

// Width of the invisible hot zone along the left edge, and how far (px) a
// drag inside it has to travel before it counts as a deliberate "swipe
// back" rather than an accidental wobble.
const EDGE_WIDTH = 32;
const SWIPE_BACK_THRESHOLD = 60;
// Clears every screen's own header row (back chevron + title), so this
// never competes with actually tapping that button — the strip only
// starts below it.
const TOP_INSET = 56;

/**
 * An invisible strip along the screen's left edge that turns a rightward
 * drag starting there into the same action as tapping the screen's own
 * back chevron (HeaderScreenLayout, DetailHero, ReelFeed's back button,
 * etc.) — the standard "swipe from the edge to go back" gesture most
 * native apps give you for free via the OS, which this app doesn't get
 * automatically since its headers are custom/hidden here.
 *
 * Deliberately edge-only, not "swipe anywhere on the screen": most of
 * these screens have their own scrollable content (a form, a message
 * list, a feed) directly underneath, and a PanResponder up at the root
 * competing with that content's own vertical scrolling is exactly the
 * kind of gesture conflict this pattern (borrowed from how real navigation
 * libraries implement their own back-swipe) is built to avoid — the strip
 * is the only thing occupying that thin edge column, so there's nothing
 * else there to conflict with.
 *
 * `onBack` should be the EXACT same handler the screen's own back button
 * already calls (usually `() => router.back()`, sometimes a custom one
 * like a "retake" step) — this never second-guesses it with a
 * `canGoBack()` check the button itself doesn't have, so swiping and
 * tapping stay identical (verified: on a screen reached via a fresh direct
 * URL load rather than real in-app navigation, `router.back()` has nowhere
 * to go and logs Expo Router's own "GO_BACK not handled" dev warning for
 * BOTH the tap and the swipe alike — not a bug in either). Render this as
 * an extra sibling near the end of the screen's outermost (position:
 * relative, the View default) container.
 */
export function SwipeBackEdge({ onBack }: { onBack: () => void }) {
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) => gesture.dx > 10 && gesture.dx > Math.abs(gesture.dy) * 1.5,
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dx >= SWIPE_BACK_THRESHOLD) {
            onBack();
          }
        },
      }),
    [onBack]
  );

  return <View pointerEvents="auto" style={styles.edge} {...panResponder.panHandlers} />;
}

const styles = StyleSheet.create({
  edge: {
    position: 'absolute',
    left: 0,
    top: TOP_INSET,
    bottom: 0,
    width: EDGE_WIDTH,
    // Without this, whatever scrollable content the screen renders after
    // this in JSX (a ScrollView, a FlatList) paints on top of it and
    // swallows the touch before this ever sees it — positioned siblings
    // stack in DOM order by default, and this is deliberately rendered
    // FIRST (see the component's own doc comment on where to place it).
    zIndex: 10,
  },
});
