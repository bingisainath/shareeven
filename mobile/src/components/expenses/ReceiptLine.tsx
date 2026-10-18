// src/components/expenses/ReceiptLine.tsx
// One printed line of a receipt photo, cut out and turned upright, so an item can be checked at a glance.
// Same idea as web/src/components/expenses/ReceiptLine.tsx (a clipped view instead of a canvas).
import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import type { SourceBox } from '../../api/expenses';
import { colors, radius } from '../../theme';

const MAX_HEIGHT = 112;

const ReceiptLine: React.FC<{ uri: string; box: SourceBox }> = ({ uri, box }) => {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    let live = true;
    Image.getSize(uri, (w, h) => { if (live) setSize({ w, h }); }, () => undefined);
    return () => { live = false; };
  }, [uri]);

  let crop: React.ReactNode = null;
  if (size && width) {
    const { w: W, h: H } = size;
    const [x0, y0, x1, y1] = box.box;
    // A margin of about half a line around it, so the neighbouring lines give context
    const pad = Math.min((x1 - x0) * W, (y1 - y0) * H) * 0.6;
    const sx = Math.max(0, x0 * W - pad);
    const sy = Math.max(0, y0 * H - pad);
    const sw = Math.min(W, x1 * W + pad) - sx;
    const sh = Math.min(H, y1 * H + pad) - sy;
    const sideways = Math.abs(box.turned) === 90;
    // Fit the upright strip to the row's width, but no taller than MAX_HEIGHT
    let k = width / (sideways ? sh : sw);
    if ((sideways ? sw : sh) * k > MAX_HEIGHT) k = MAX_HEIGHT / (sideways ? sw : sh);
    const innerW = sw * k;
    const innerH = sh * k;
    const outerW = sideways ? innerH : innerW;
    const outerH = sideways ? innerW : innerH;
    crop = (
      <View style={[styles.frame, { width: outerW, height: outerH }]}>
        <View style={{
          position: 'absolute', width: innerW, height: innerH, left: (outerW - innerW) / 2, top: (outerH - innerH) / 2, overflow: 'hidden',
          transform: [{ rotate: box.turned === 90 ? '-90deg' : box.turned === -90 ? '90deg' : '0deg' }],
        }}>
          <Image source={{ uri }} style={{ position: 'absolute', width: W * k, height: H * k, left: -sx * k, top: -sy * k }} />
        </View>
      </View>
    );
  }
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={styles.wrap} accessibilityRole="image" accessibilityLabel="This line on the receipt">
      {crop}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { marginTop: 8, alignItems: 'center' },
  frame: { overflow: 'hidden', borderRadius: radius.md, borderWidth: 1, borderColor: colors.muted200, backgroundColor: colors.white },
});

export default ReceiptLine;
