import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { CountryPicker } from '@/components/CountryPicker';
import { FormField } from '@/components/FormField';
import { OnboardingProgress } from '@/components/OnboardingProgress';
import { COUNTRIES } from '@/constants/countries';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useOnboardingDraft } from '@/providers/OnboardingDraftProvider';
import { detectCurrentCity } from '@/services/location';

type Mode = 'choose' | 'manual' | 'confirm';

const LOCATION_ERROR_MESSAGES: Record<string, string> = {
  'permission-denied': "We couldn't access your location. You can still choose your city manually.",
  unavailable: 'Location services are off. You can still choose your city manually.',
  'no-result': "We couldn't figure out your city from your location. Try choosing it manually.",
  unknown: 'Something went wrong finding your location. You can still choose your city manually.',
};

export default function CityScreen() {
  const { draft, setCity } = useOnboardingDraft();
  const [mode, setMode] = useState<Mode>(draft.cityName ? 'confirm' : 'choose');
  const [isDetecting, setIsDetecting] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [cityName, setCityName] = useState(draft.cityName);
  const [countryCode, setCountryCode] = useState(draft.countryCode);
  const [cityError, setCityError] = useState<string | null>(null);

  const countryName = COUNTRIES.find((country) => country.code === countryCode)?.name ?? countryCode;

  const handleUseCurrentLocation = async () => {
    setLocationError(null);
    setIsDetecting(true);
    const result = await detectCurrentCity();
    setIsDetecting(false);

    if (!result.ok) {
      setLocationError(LOCATION_ERROR_MESSAGES[result.reason] ?? result.message);
      return;
    }

    setCityName(result.city.cityName);
    setCountryCode(result.city.countryCode);
    setMode('confirm');
  };

  const handleManualContinue = () => {
    const trimmedCity = cityName.trim();
    if (!trimmedCity) {
      setCityError('Enter your city.');
      return;
    }
    if (!countryCode) {
      setCityError('Select your country.');
      return;
    }
    setCityError(null);
    setMode('confirm');
  };

  const handleConfirm = () => {
    setCity(cityName.trim(), countryCode);
    router.push('/interests');
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.content}>
        <OnboardingProgress step={2} total={3} />

        {mode === 'choose' && (
          <View style={styles.section}>
            <Text style={styles.title}>Where are you?</Text>
            <Text style={styles.description}>Around Me uses your city to show you what&apos;s happening nearby.</Text>

            <View style={styles.actions}>
              <Button label="Use my current location" onPress={handleUseCurrentLocation} loading={isDetecting} />
              <Button label="Choose city manually" variant="secondary" onPress={() => setMode('manual')} />
              {locationError ? <Text style={styles.error}>{locationError}</Text> : null}
            </View>
          </View>
        )}

        {mode === 'manual' && (
          <View style={styles.section}>
            <Text style={styles.title}>Where are you?</Text>
            <Text style={styles.description}>Tell us your city and country.</Text>

            <View style={styles.form}>
              <FormField
                label="City"
                value={cityName}
                onChangeText={(value) => {
                  setCityName(value);
                  setCityError(null);
                }}
                placeholder="Karlstad"
                autoCapitalize="words"
                autoCorrect={false}
              />
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Country</Text>
                <CountryPicker
                  countryCode={countryCode}
                  onSelect={(country) => {
                    setCountryCode(country.code);
                    setCityError(null);
                  }}
                />
              </View>
              {cityError ? <Text style={styles.error}>{cityError}</Text> : null}
            </View>

            <View style={styles.actions}>
              <Button label="Continue" onPress={handleManualContinue} />
              <Pressable onPress={() => setMode('choose')} style={styles.backLink} hitSlop={8}>
                <Text style={styles.backLinkText}>Back</Text>
              </Pressable>
            </View>
          </View>
        )}

        {mode === 'confirm' && (
          <View style={styles.section}>
            <Text style={styles.title}>Where are you?</Text>

            <View style={styles.confirmCard}>
              <Text style={styles.confirmText}>
                📍 {cityName}, {countryName}
              </Text>
            </View>

            <View style={styles.actions}>
              <Button label="Continue" onPress={handleConfirm} />
              <Pressable onPress={() => setMode('choose')} style={styles.backLink} hitSlop={8}>
                <Text style={styles.backLinkText}>Change city</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    flex: 1,
    padding: Spacing.xl,
    gap: Spacing.xl,
  },
  section: {
    flex: 1,
    justifyContent: 'center',
    gap: Spacing.md,
  },
  title: {
    color: Colors.text,
    fontSize: 26,
    fontWeight: '800',
  },
  description: {
    color: Colors.textSecondary,
    fontSize: 15,
    lineHeight: 21,
  },
  form: {
    gap: Spacing.md,
    marginTop: Spacing.md,
  },
  field: {
    gap: Spacing.xs,
  },
  fieldLabel: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  actions: {
    gap: Spacing.md,
    marginTop: Spacing.xl,
  },
  error: {
    color: Colors.error,
    fontSize: 13,
    textAlign: 'center',
  },
  backLink: {
    alignSelf: 'center',
    paddingVertical: Spacing.sm,
  },
  backLinkText: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontWeight: '600',
  },
  confirmCard: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    paddingVertical: Spacing.xl,
    paddingHorizontal: Spacing.lg,
    alignItems: 'center',
  },
  confirmText: {
    color: Colors.text,
    fontSize: 18,
    fontWeight: '700',
  },
});
