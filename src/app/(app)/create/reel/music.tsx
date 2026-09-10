import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { EmptyState } from '@/components/EmptyState';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { LoadingState } from '@/components/LoadingState';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { fetchPublicProfile } from '@/services/publicProfile';
import { setPendingPreselectedSound } from '@/services/reelCameraHandoff';
import { resolveSoundAudioUrl } from '@/services/stories';
import { fetchSavedSounds, unsavePost, type SavedSound } from '@/services/saved';
import type { SelectedReelMusic } from '@/types/reel';
import type { PublicProfile } from '@/types/social';
import { resolveAudioDurationMs } from '@/utils/audioMetadata';
import { validateSelectedReelMusic } from '@/utils/reelMusicValidation';

type LoadStatus = 'loading' | 'loaded' | 'error';
type MusicTab = 'favorites' | 'upload';

/**
 * The music picker — reached by tapping the music icon on the capture
 * screen (src/app/(app)/create/reel/camera.tsx), which used to open the
 * device file picker directly. Now a real page: search + two sections —
 * Favorites (every sound you've saved from a Sound sheet, see
 * SavedSound in src/services/saved.ts) and Upload (the original
 * device-file-picker flow, moved here from camera.tsx). Either path ends
 * the same way: hand the chosen sound to camera.tsx via
 * reelCameraHandoff's pendingPreselectedSound (the same one-shot slot
 * "Use audio" on the Sound sheet already uses) and navigate back —
 * camera.tsx picks it up via a focus effect since it's already mounted
 * underneath this screen, not a fresh mount.
 *
 * Picking (or uploading) a sound here is just USING it for this one
 * recording — it never creates a NEW Saved relationship on its own. Saving
 * a sound in the first place is a separate, deliberate action (the
 * bookmark icon on the Sound sheet, src/components/SoundSheet.tsx) — this
 * screen only ever reads the Favorites list, plus the one write it does
 * own: un-favoriting (see the bookmark icon on each Favorites row below).
 * That removal is deliberately NOT immediate — tapping it just toggles
 * the icon (filled = stays saved, outline = will be removed), so the row
 * stays visible and fully undoable while you're still browsing. The real
 * unsavePost() calls only fire once this screen is actually left (see the
 * unmount effect below), for whichever sounds are still marked at that
 * exact moment — toggling one back to filled before leaving cancels it
 * out with no write at all.
 */
export default function MusicPickerScreen() {
  const { user } = useAuth();
  const [tab, setTab] = useState<MusicTab>('favorites');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [savedSounds, setSavedSounds] = useState<SavedSound[]>([]);
  const [authorProfiles, setAuthorProfiles] = useState<Record<string, PublicProfile | null>>({});
  const [isResolving, setIsResolving] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // musicHash values currently marked "remove from favorites" — see this
  // component's own doc comment above for the full deferred-removal model.
  const [pendingRemovals, setPendingRemovals] = useState<Set<string>>(new Set());
  const pendingRemovalsRef = useRef(pendingRemovals);
  useEffect(() => {
    pendingRemovalsRef.current = pendingRemovals;
  }, [pendingRemovals]);

  // Commits whatever is STILL marked at the moment this screen is
  // actually left — via the back button, a swipe-back gesture, or
  // picking/uploading a sound (both of which call router.back() too).
  // Reads the ref (not `pendingRemovals` directly) so this always sees
  // the latest set regardless of when this effect itself last ran — a
  // plain unmount-only effect (empty deps) would otherwise close over
  // whatever `pendingRemovals` was at MOUNT time, always empty.
  useEffect(() => {
    return () => {
      if (!user) return;
      pendingRemovalsRef.current.forEach((musicHash) => {
        unsavePost(user.uid, 'sound', musicHash).catch(() => {});
      });
    };
  }, [user]);

  const handleToggleFavorite = (musicHash: string) => {
    setPendingRemovals((prev) => {
      const next = new Set(prev);
      if (next.has(musicHash)) next.delete(musicHash);
      else next.add(musicHash);
      return next;
    });
  };

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    // Resets fresh on mount — this screen is always a fresh push, never
    // reused across visits.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus('loading');
    fetchSavedSounds(user.uid)
      .then(async (sounds) => {
        if (cancelled) return;
        setSavedSounds(sounds);
        const profiles = await Promise.all(sounds.map((sound) => fetchPublicProfile(sound.originReel.authorUid)));
        if (cancelled) return;
        const byUid: Record<string, PublicProfile | null> = {};
        sounds.forEach((sound, index) => {
          byUid[sound.originReel.authorUid] = profiles[index];
        });
        setAuthorProfiles(byUid);
        setStatus('loaded');
      })
      .catch((catchError) => {
        if (__DEV__) {
          console.warn('[music] fetchSavedSounds failed:', catchError);
        }
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const filteredSounds = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return savedSounds;
    return savedSounds.filter((sound) => {
      const profile = authorProfiles[sound.originReel.authorUid];
      return sound.originReel.musicTitle.toLowerCase().includes(q) || (profile?.displayName.toLowerCase().includes(q) ?? false);
    });
  }, [savedSounds, authorProfiles, query]);

  const handleSelectSaved = async (sound: SavedSound) => {
    if (isResolving) return;
    setError(null);
    setIsResolving(true);
    const url = await resolveSoundAudioUrl(sound.musicHash);
    setIsResolving(false);
    if (!url) {
      setError("This sound isn't available right now.");
      return;
    }
    const candidate: SelectedReelMusic = {
      uri: url,
      title: sound.originReel.musicTitle,
      fileSizeBytes: sound.originReel.musicFileSizeBytes,
      mimeType: sound.originReel.musicStorageContentType,
      durationMs: sound.originReel.musicDurationMs > 0 ? sound.originReel.musicDurationMs : null,
    };
    setPendingPreselectedSound(candidate);
    router.back();
  };

  const handleUpload = async () => {
    if (isUploading) return;
    setError(null);
    setIsUploading(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: 'audio/*', copyToCacheDirectory: true });
      if (result.canceled || result.assets.length === 0) return;

      const asset = result.assets[0];
      const mimeType = asset.mimeType ?? null;
      if (!mimeType || !mimeType.startsWith('audio/')) {
        setError('Choose an audio file.');
        return;
      }
      const fileSizeBytes = asset.size && asset.size > 0 ? asset.size : new File(asset.uri).size || 0;
      const durationMs = await resolveAudioDurationMs(asset.uri);

      const candidate: SelectedReelMusic = {
        uri: asset.uri,
        title: asset.name,
        fileSizeBytes,
        mimeType,
        durationMs,
      };

      const validation = validateSelectedReelMusic(candidate);
      if (!validation.ok) {
        setError(validation.message);
        return;
      }

      setPendingPreselectedSound(candidate);
      router.back();
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <HeaderScreenLayout title="Music">
      <View style={styles.searchWrap}>
        <Ionicons name="search-outline" size={18} color={Colors.textSecondary} style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search your saved sounds"
          placeholderTextColor={Colors.textSecondary}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {query.length > 0 ? (
          <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityRole="button" accessibilityLabel="Clear search">
            <Ionicons name="close-circle" size={18} color={Colors.textSecondary} />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.tabs}>
        <Pressable
          onPress={() => setTab('favorites')}
          style={[styles.tab, tab === 'favorites' && styles.tabActive]}
          accessibilityRole="tab"
          accessibilityState={{ selected: tab === 'favorites' }}
        >
          <Text style={[styles.tabText, tab === 'favorites' && styles.tabTextActive]}>Favorites</Text>
        </Pressable>
        <Pressable
          onPress={() => setTab('upload')}
          style={[styles.tab, tab === 'upload' && styles.tabActive]}
          accessibilityRole="tab"
          accessibilityState={{ selected: tab === 'upload' }}
        >
          <Text style={[styles.tabText, tab === 'upload' && styles.tabTextActive]}>Upload</Text>
        </Pressable>
      </View>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      {tab === 'favorites' ? (
        status === 'loading' ? (
          <LoadingState size="small" />
        ) : status === 'error' ? (
          <EmptyState bare icon="alert-circle-outline" title="Couldn't load your saved sounds" />
        ) : filteredSounds.length === 0 ? (
          <EmptyState
            bare
            icon="bookmark-outline"
            title={savedSounds.length === 0 ? 'No saved sounds yet' : 'No sounds found'}
            body={savedSounds.length === 0 ? 'Save a sound from any post to find it here.' : undefined}
          />
        ) : (
          <View style={styles.list}>
            {filteredSounds.map((sound) => {
              const profile = authorProfiles[sound.originReel.authorUid];
              const isMarkedForRemoval = pendingRemovals.has(sound.musicHash);
              return (
                <Pressable
                  key={sound.savedId}
                  onPress={() => handleSelectSaved(sound)}
                  disabled={isResolving}
                  style={styles.row}
                  accessibilityRole="button"
                  accessibilityLabel={`Use ${sound.originReel.musicTitle}`}
                >
                  <Avatar name={profile?.displayName ?? sound.originReel.authorDisplayName} photoURL={profile?.photoURL} size={44} />
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {sound.originReel.musicTitle || 'Original audio'}
                    </Text>
                    <Text style={styles.rowSubtitle} numberOfLines={1}>
                      {profile?.displayName ?? sound.originReel.authorDisplayName}
                    </Text>
                  </View>
                  {isResolving ? <ActivityIndicator size="small" color={Colors.textSecondary} /> : null}
                  {/* Filled = stays in Favorites, outline = will be
                      removed once this screen closes — see this
                      component's own doc comment for the full deferred
                      model. A nested Pressable, not the row's own tap —
                      RN awards a touch to the innermost one, so this
                      never also triggers "use this sound". accessibilityRole
                      is deliberately "none", not "button" — same reasoning
                      as AuthorLink's own doc comment (src/components/AuthorLink.tsx):
                      nesting a real <button> inside the row's own <button>
                      is invalid HTML on web and breaks click routing there. */}
                  <Pressable
                    onPress={() => handleToggleFavorite(sound.musicHash)}
                    hitSlop={10}
                    accessibilityRole="none"
                    accessibilityLabel={isMarkedForRemoval ? 'Keep in favorites' : 'Remove from favorites'}
                  >
                    <Ionicons
                      name={isMarkedForRemoval ? 'bookmark-outline' : 'bookmark'}
                      size={22}
                      color={isMarkedForRemoval ? Colors.textSecondary : Colors.accent}
                    />
                  </Pressable>
                </Pressable>
              );
            })}
          </View>
        )
      ) : (
        <Pressable onPress={handleUpload} disabled={isUploading} style={styles.uploadButton} accessibilityRole="button" accessibilityLabel="Upload from your device">
          {isUploading ? (
            <ActivityIndicator color={Colors.text} />
          ) : (
            <>
              <Ionicons name="cloud-upload-outline" size={28} color={Colors.text} />
              <Text style={styles.uploadButtonText}>Upload from your device</Text>
            </>
          )}
        </Pressable>
      )}
    </HeaderScreenLayout>
  );
}

const styles = StyleSheet.create({
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
    marginBottom: Spacing.md,
  },
  searchIcon: {
    marginTop: 1,
  },
  searchInput: {
    flex: 1,
    minHeight: 48,
    color: Colors.text,
    fontSize: 15,
  },
  tabs: {
    flexDirection: 'row',
    gap: Spacing.xs,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 4,
    marginBottom: Spacing.md,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.sm,
    borderRadius: Radius.full,
  },
  tabActive: {
    backgroundColor: Colors.background,
  },
  tabText: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontWeight: '700',
  },
  tabTextActive: {
    color: Colors.accent,
  },
  errorText: {
    color: Colors.error,
    fontSize: 13,
    textAlign: 'center',
    marginBottom: Spacing.sm,
  },
  list: {
    gap: Spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  rowSubtitle: {
    color: Colors.textSecondary,
    fontSize: 13,
  },
  uploadButton: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.xxl,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    borderStyle: 'dashed',
  },
  uploadButtonText: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
});
