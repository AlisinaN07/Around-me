import { router } from 'expo-router';
import { useEffect } from 'react';

/**
 * Legacy text-only Post creation is retired (Step 41.2C — the user-facing
 * "Post" concept is now video-first, technically backed by reels/{reelId};
 * see src/utils/profilePosts.ts). This route is kept only so an existing
 * bookmark/link to /create/post doesn't dead-end on a missing route or a
 * confusing 404 — it never renders the old text-Post form, it just sends
 * the visitor straight to the real Post creation flow, which starts with
 * the camera (Step 41.2D.1) rather than the caption/category form.
 *
 * This is UI-only: content/{contentId} documents with type == 'post' that
 * already exist remain fully intact, readable, likeable, commentable,
 * reportable, moderatable, and author-self-deletable — nothing about the
 * backend changed, only this screen's ability to create a NEW one.
 */
export default function CreatePostScreen() {
  useEffect(() => {
    router.replace('/create/reel/camera');
  }, []);

  return null;
}
