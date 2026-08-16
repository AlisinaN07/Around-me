/**
 * `getReactNativePersistence` exists at runtime (Metro resolves the
 * "react-native" package export condition), but the firebase package's
 * published .d.ts doesn't vary by platform condition, so TypeScript can't
 * see it through a plain import. This augmentation restores the type.
 *
 * The top-level import below is required: it's what makes this file a
 * module, which is what makes `declare module` below an *augmentation*
 * of the real 'firebase/auth' types instead of replacing them outright.
 */
import type { Persistence } from 'firebase/auth';

declare module 'firebase/auth' {
  type ReactNativeAsyncStorage = {
    setItem(key: string, value: string): Promise<void>;
    getItem(key: string): Promise<string | null>;
    removeItem(key: string): Promise<void>;
  };

  export function getReactNativePersistence(storage: ReactNativeAsyncStorage): Persistence;
}
