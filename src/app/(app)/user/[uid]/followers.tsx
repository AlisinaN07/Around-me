import { useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';

import { UserList } from '@/components/UserList';
import { fetchFollowers } from '@/services/following';

export default function FollowersScreen() {
  const { uid } = useLocalSearchParams<{ uid: string }>();
  const fetcher = useCallback(() => fetchFollowers(uid), [uid]);

  return <UserList title="Followers" emptyText="No followers yet." fetcher={fetcher} />;
}
