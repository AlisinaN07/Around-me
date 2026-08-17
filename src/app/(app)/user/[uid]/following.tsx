import { useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';

import { UserList } from '@/components/UserList';
import { fetchFollowing } from '@/services/following';

export default function FollowingScreen() {
  const { uid } = useLocalSearchParams<{ uid: string }>();
  const fetcher = useCallback(() => fetchFollowing(uid), [uid]);

  return <UserList title="Following" emptyText="Not following anyone yet." fetcher={fetcher} />;
}
