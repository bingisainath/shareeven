// src/components/common/ErrorBoundary.tsx
// One rendering error (an odd message, a bad value) shouldn't take the whole app down: show a
// "Try again" screen instead, and log what happened (adb logcat, tag ReactNativeJS).
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, space } from '../../theme';

interface State { error: Error | null }

export default class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[app] screen crashed:', error?.message, info?.componentStack?.split('\n').slice(0, 6).join('\n'));
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <View style={styles.wrap}>
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.text}>This screen hit a problem. Your chats and messages are safe.</Text>
        <Pressable onPress={() => this.setState({ error: null })} style={styles.button} accessibilityRole="button">
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space(8), backgroundColor: colors.white, gap: space(3) },
  title: { fontSize: 18, fontWeight: '700', color: colors.muted900 },
  text: { fontSize: 14, color: colors.muted600, textAlign: 'center' },
  button: { marginTop: space(2), paddingHorizontal: space(6), paddingVertical: space(3), borderRadius: radius.full, backgroundColor: colors.primary600 },
  buttonText: { color: colors.white, fontWeight: '700', fontSize: 15 },
});
