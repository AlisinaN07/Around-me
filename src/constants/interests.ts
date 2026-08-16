/**
 * Interest catalog — stable IDs are what get stored in Firestore;
 * label/emoji are display-only and safe to change without a migration.
 */

export type Interest = { id: string; label: string; emoji: string };

export const INTERESTS: Interest[] = [
  { id: 'music', label: 'Music', emoji: '🎵' },
  { id: 'food', label: 'Food', emoji: '🍔' },
  { id: 'nightlife', label: 'Nightlife', emoji: '🌃' },
  { id: 'sports', label: 'Sports', emoji: '⚽' },
  { id: 'fitness', label: 'Fitness', emoji: '💪' },
  { id: 'gaming', label: 'Gaming', emoji: '🎮' },
  { id: 'cars', label: 'Cars', emoji: '🚗' },
  { id: 'art', label: 'Art', emoji: '🎨' },
  { id: 'cafes', label: 'Cafés', emoji: '☕' },
  { id: 'student_life', label: 'Student life', emoji: '🎓' },
  { id: 'pets', label: 'Pets', emoji: '🐾' },
  { id: 'outdoors', label: 'Outdoors', emoji: '🏞️' },
  { id: 'movies', label: 'Movies', emoji: '🎬' },
  { id: 'networking', label: 'Networking', emoji: '🤝' },
  { id: 'parties', label: 'Parties', emoji: '🎉' },
  { id: 'family', label: 'Family', emoji: '👨‍👩‍👧' },
  { id: 'shopping', label: 'Shopping', emoji: '🛍️' },
  { id: 'travel', label: 'Travel', emoji: '✈️' },
];

export const MIN_INTERESTS = 3;
export const MAX_INTERESTS = 8;
