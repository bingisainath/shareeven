// src/components/common/DownloadsBar.tsx
// "Saving report.pdf · 42%" floating at the bottom of the screen while files download to the phone
// (store/downloads). Before, saving a big file showed nothing until it was done.
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, space } from '../../theme';
import { useDownloads } from '../../store/downloads';

const DownloadsBar: React.FC = () => {
  const active = useDownloads((s) => s.active);
  const insets = useSafeAreaInsets();
  if (!active.length) return null;
  const first = active[0];
  const percent = first.progress === undefined ? '' : first.progress >= 1 ? ' · saving' : ` · ${Math.floor(first.progress * 100)}%`;
  const more = active.length > 1 ? ` (+${active.length - 1} more)` : '';
  return (
    <View pointerEvents="none" style={[styles.wrap, { bottom: insets.bottom + 96 }]}>
      <View style={styles.bar} accessibilityRole="progressbar" accessibilityLabel={`Downloading ${first.name}${percent}`}>
        <ActivityIndicator size="small" color={colors.white} />
        <Text style={styles.text} numberOfLines={1}>Downloading {first.name}{percent}{more}</Text>
      </View>
      {first.progress !== undefined && (
        <View style={styles.track}><View style={[styles.fill, { width: `${Math.round(Math.min(1, first.progress) * 100)}%` }]} /></View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: space(6), right: space(6), alignItems: 'center', zIndex: 100 },
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: space(2), maxWidth: '100%',
    paddingHorizontal: space(4), paddingVertical: space(2.5), borderRadius: radius.lg, backgroundColor: 'rgba(30,24,48,0.92)',
  },
  text: { color: colors.white, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  track: { height: 3, width: '80%', marginTop: 4, borderRadius: 2, backgroundColor: 'rgba(30,24,48,0.2)', overflow: 'hidden' },
  fill: { height: 3, backgroundColor: colors.primary700 },
});

export default DownloadsBar;
