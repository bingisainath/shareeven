/**
 * ShareEven mobile app (React Native).
 * Chats and expenses on the same server as the web app.
 */
import React, { useEffect } from 'react';
import { StatusBar, View } from 'react-native';
import { recordRootHeight } from './src/hooks/useKeyboardOffset';
import { NavigationContainer, DefaultTheme, createNavigationContainerRef } from '@react-navigation/native';
import { onNotificationTap } from './src/notifications/push';
import type { AppStackParams } from './src/navigation/types';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import RootNavigator from './src/navigation/RootNavigator';
import { DialogHost } from './src/components/common/Dialog';
import DownloadsBar from './src/components/common/DownloadsBar';
import IncomingShare from './src/share/IncomingShare';
import ErrorBoundary from './src/components/common/ErrorBoundary';
import { pruneCaches } from './src/crypto/media';
import { useAuth } from './src/store/auth';
import { colors } from './src/theme';

const theme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, primary: colors.primary700, background: colors.background, card: colors.white, text: colors.muted900, border: colors.muted200 },
};

export const navigationRef = createNavigationContainerRef<AppStackParams>();

export default function App() {
  const restore = useAuth((s) => s.restore);
  const status = useAuth((s) => s.status);
  useEffect(() => { restore(); }, [restore]);
  useEffect(() => { pruneCaches().catch(() => undefined); }, []); // old decrypted media and shared-in copies

  // Tapping a notification opens that chat (or Notices) (once signed in and navigation is ready)
  useEffect(() => {
    if (status !== 'signedIn') return;
    const when = (go: () => void) => (navigationRef.isReady() ? go() : setTimeout(go, 500));
    return onNotificationTap(
      (conversationId) => when(() => navigationRef.navigate('Chat', { conversationId })),
      () => when(() => navigationRef.navigate('Notices')),
    );
  }, [status]);
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" backgroundColor={colors.white} />
      {/* Records the app's height so screens can place the keyboard (src/hooks/useKeyboardOffset.ts) */}
      <View style={{ flex: 1 }} onLayout={(e) => recordRootHeight(e.nativeEvent.layout.height)}>
        <ErrorBoundary>
          <NavigationContainer ref={navigationRef} theme={theme}>
            <RootNavigator />
          </NavigationContainer>
        </ErrorBoundary>
        {/* "Share to ShareEven" from the gallery and other apps */}
        <IncomingShare openChat={(conversationId) => (navigationRef.isReady() ? navigationRef.navigate('Chat', { conversationId }) : undefined)} />
        {/* Files downloading to the phone, and how far */}
        <DownloadsBar />
      </View>
      <DialogHost />
    </SafeAreaProvider>
  );
}
