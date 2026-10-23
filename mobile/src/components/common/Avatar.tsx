// src/components/Avatar.tsx
// A profile photo, or with no photo a solid person (two for a group) on a soft colour, like WhatsApp's.
import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { mediaUrl } from '../../config';
import { colors } from '../../theme';
import { avatarTone, GROUP_SHAPES, PERSON_SHAPES } from '../../utils/avatarTone';

interface Props {
  uri?: string | null;
  name?: string | null;
  size?: number;
  online?: boolean;
  /** A group chat: the two-person icon. */
  group?: boolean;
}

const Avatar: React.FC<Props> = ({ uri, name, size = 44, online, group }) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [uri]);
  const source = !failed ? mediaUrl(uri) : undefined;
  const tone = avatarTone(name);
  return (
    <View style={{ width: size, height: size }} accessibilityLabel={name || (group ? 'Group' : 'Avatar')}>
      {source ? (
        <Image source={{ uri: source }} style={[styles.round, { width: size, height: size, borderRadius: size / 2 }]} onError={() => setFailed(true)} />
      ) : (
        <View style={[styles.round, styles.fallback, { width: size, height: size, borderRadius: size / 2, backgroundColor: tone.bg }]}>
          <Svg width={size} height={size} viewBox="0 0 24 24">
            {(group ? GROUP_SHAPES : PERSON_SHAPES).map((p) => <Path key={p.d} d={p.d} fill={tone.fg} opacity={p.opacity ?? 1} />)}
          </Svg>
        </View>
      )}
      {online && <View style={[styles.dot, { width: size * 0.28, height: size * 0.28, borderRadius: size * 0.14 }]} />}
    </View>
  );
};

const styles = StyleSheet.create({
  round: { overflow: 'hidden' },
  fallback: { alignItems: 'center', justifyContent: 'center' },
  dot: { position: 'absolute', right: 0, bottom: 0, backgroundColor: colors.success600, borderWidth: 2, borderColor: colors.white },
});

export default Avatar;
