// src/components/common/Gradient.tsx
// A diagonal two-colour gradient that fills its parent (put it first inside a View with overflow hidden).

import React, { useId, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

/**
 * Measures its parent's box and draws the gradient at exactly that size. On Android a "100%"-sized
 * SVG can be drawn before the card's final layout (e.g. when its text wraps), leaving a band of the
 * card's plain background next to the gradient.
 */
const Gradient: React.FC<{ from: string; to: string }> = ({ from, to }) => {
  const id = `g${useId().replace(/:/g, '')}`;
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        if (!size || size.w !== width || size.h !== height) setSize({ w: width, h: height });
      }}
    >
      <Svg width={size ? size.w : '100%'} height={size ? size.h : '100%'}>
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={from} />
            <Stop offset="1" stopColor={to} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width={size ? size.w : '100%'} height={size ? size.h : '100%'} fill={`url(#${id})`} />
      </Svg>
    </View>
  );
};

/** The purple used for the big summary cards (Expenses, a chat's position). */
// middle: the card's own background, so nothing shows as a different purple before the gradient draws
export const CARD_GRADIENT = { from: '#4a376e', to: '#705798', middle: '#5d4783' };

export default Gradient;
