// src/components/Avatar.tsx
import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { mediaUrl } from '../../config';
import { colors } from '../../theme';
import Gradient, { toneFor } from './Gradient';
import { initials } from '../../utils/initials';

export { initials }; // emoji and Indian scripts stay whole (utils/initials.ts)

interface Props {
  uri?: string | null;
  name?: string | null;
  size?: number;
  online?: boolean;
}

const Avatar: React.FC<Props> = ({ uri, name, size = 44, online }) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [uri]);
  const source = !failed ? mediaUrl(uri) : undefined;
  return (
    <View style={{ width: size, height: size }} accessibilityLabel={name || 'Avatar'}>
      {source ? (
        <Image source={{ uri: source }} style={[styles.round, { width: size, height: size, borderRadius: size / 2 }]} onError={() => setFailed(true)} />
      ) : (
        <View style={[styles.round, styles.fallback, { width: size, height: size, borderRadius: size / 2 }]}>
          <Gradient from={toneFor(name || '?')[0]} to={toneFor(name || '?')[1]} />
          <Text style={[styles.initials, { fontSize: size * 0.36 }]}>{initials(name)}</Text>
        </View>
      )}
      {online && <View style={[styles.dot, { width: size * 0.28, height: size * 0.28, borderRadius: size * 0.14 }]} />}
    </View>
  );
};

const styles = StyleSheet.create({
  round: { overflow: 'hidden' },
  fallback: { backgroundColor: colors.primary500, alignItems: 'center', justifyContent: 'center' },
  initials: { color: colors.white, fontWeight: '700' },
  dot: { position: 'absolute', right: 0, bottom: 0, backgroundColor: colors.success600, borderWidth: 2, borderColor: colors.white },
});

export default Avatar;
