import { router } from 'expo-router';
import { useEffect } from 'react';

/**
 * Activity creation is retired (Step 41.2B — the old user-joinable Activity
 * product is no longer part of Around Me). This route is kept only so an
 * existing bookmark/link to /create/activity doesn't dead-end on a missing
 * route or a confusing 404 — it never renders a creation form, it just
 * sends the visitor back to the real Create surface immediately.
 *
 * This is UI-only: content/{contentId} documents with type == 'activity'
 * that already exist remain fully intact, readable, reportable,
 * moderatable, and author-self-deletable — nothing about the backend
 * changed, only this screen's ability to create a NEW one.
 */
export default function CreateActivityScreen() {
  useEffect(() => {
    router.replace('/create');
  }, []);

  return null;
}
