// src/components/EncryptionInfo.tsx
// Chat info: is this chat end-to-end encrypted, and (direct chats) the security code to compare.
// With encryption v2 the code comes from both account keys; comparing it, or scanning the QR code
// on the other person's screen, marks them verified (same as web/src/components/organisms/EncryptionInfo.tsx).
import React, { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Camera, CameraType } from 'react-native-camera-kit';
import QRCode from 'react-native-qrcode-svg';
import { BadgeCheck, Lock, LockOpen, ScanLine, X } from 'lucide-react-native';
import { scanVerification, useTrust, useTrustActions } from '../../crypto/v2-platform/trust';
import { cameraAllowed } from '../../utils/camera';
import { publicKeysOf, securityCode } from '../../crypto/e2e';
import { e2eSession } from '../../crypto/session';
import { useChatEncryption } from '../../crypto/useChatEncryption';
import { e2eService } from '../../services/e2e.service';
import { colors, space } from '../../theme';
import { showAlert } from '../common/Dialog';

const EncryptionInfo: React.FC<{ conversationId: string; otherId?: string; otherName?: string }> = ({ conversationId, otherId, otherName }) => {
  const encryption = useChatEncryption(conversationId);
  const [code, setCode] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [scanning, setScanning] = useState(false);
  const handled = useRef(false);
  const { trust, qr } = useTrust(otherId);
  const { verify, accept } = useTrustActions();

  const scan = async () => {
    if (!(await cameraAllowed())) return;
    handled.current = false;
    setScanning(true);
  };
  const onRead = (text: string) => {
    if (handled.current || !otherId) return; // the camera reports the same code many times a second
    handled.current = true;
    setScanning(false);
    scanVerification(otherId, text).then((result) => {
      if (result === 'match') showAlert('Verified', `The codes match. ${otherName || 'They'} is now marked as verified.`);
      else if (result === 'mismatch') showAlert("The codes don't match", `Don't trust this chat until you've checked with ${otherName || 'them'}: one of you may have new keys, or someone may be in the middle.`);
      else showAlert('Not a security code', `Scan the QR code under the security code in ${otherName || 'their'}'s chat info.`);
    }).catch(() => undefined);
  };

  useEffect(() => {
    const keys = e2eSession.keys();
    const me = e2eSession.userId();
    if (!otherId || !keys || !me || encryption.state !== 'encrypted') return;
    e2eService.userKeys([otherId]).then((found) => {
      const theirs = found[otherId];
      if (theirs?.enc && theirs.sign) {
        setCode(securityCode({ userId: me, keys: publicKeysOf(keys) }, { userId: otherId, keys: { enc: theirs.enc, sign: theirs.sign } }));
      }
    }).catch(() => undefined);
  }, [otherId, encryption.state]);

  if (encryption.state === 'loading') return null;

  if (encryption.state === 'not-encrypted') {
    return (
      <View style={styles.row}>
        <LockOpen size={20} color={colors.warning700} />
        <View style={styles.flex}>
          <Text style={styles.title}>Not end-to-end encrypted yet</Text>
          <Text style={styles.text}>
            {otherId ? `${otherName || 'They'} hasn't set up encryption.` : `${encryption.missing.length} member${encryption.missing.length === 1 ? " hasn't" : "s haven't"} set up encryption.`}
            {' '}Messages can be sent once everyone has; expenses work as usual.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.row}>
      <Lock size={20} color={colors.primary700} />
      <View style={styles.flex}>
        <Text style={styles.title}>End-to-end encrypted</Text>
        <Text style={styles.text}>Messages and files here can only be read by the people in this chat.</Text>
        {trust?.code ? (
          <>
            {trust.verified ? (
              <View style={styles.verified}><BadgeCheck size={16} color={colors.success700} /><Text style={styles.verifiedText}>You verified {otherName || 'them'}</Text></View>
            ) : trust.needsAccept ? (
              <Text style={[styles.text, { color: colors.danger600 }]}>
                {otherName || 'Their'}'s security code changed since you verified them. Messages to them wait until you check it again or accept it.
              </Text>
            ) : null}
            {showCode ? (
              <>
                <Text style={styles.code} selectable testID="security-code">{trust.code}</Text>
                {qr && <View style={styles.qr}><QRCode value={qr} size={150} /></View>}
                <Text style={styles.text}>
                  Compare this code with {otherName || 'them'} in person or on a call, or scan the QR code on their screen.
                  If it matches, nobody is listening in. It only changes if one of you starts over with new keys.
                </Text>
                <View style={styles.actions}>
                  <Pressable onPress={scan} hitSlop={8} style={styles.action}><ScanLine size={16} color={colors.primary700} /><Text style={styles.linkInline}>Scan their code</Text></Pressable>
                  {trust.verified ? (
                    <Pressable onPress={() => verify(otherId!, false)} hitSlop={8}><Text style={[styles.linkInline, { color: colors.muted600 }]}>Remove verification</Text></Pressable>
                  ) : (
                    <Pressable onPress={() => verify(otherId!, true)} hitSlop={8}><Text style={styles.linkInline}>Mark as verified</Text></Pressable>
                  )}
                  {trust.needsAccept && (
                    <Pressable onPress={() => accept(otherId!)} hitSlop={8}><Text style={[styles.linkInline, { color: colors.muted600 }]}>Accept without checking</Text></Pressable>
                  )}
                </View>
              </>
            ) : (
              <Pressable onPress={() => setShowCode(true)} hitSlop={8}>
                <Text style={styles.link}>Verify security code</Text>
              </Pressable>
            )}
          </>
        ) : code && (showCode ? (
          <>
            <Text style={styles.code} selectable>{code}</Text>
            <Text style={styles.text}>
              Compare this code with {otherName || 'them'} in person or on a call. If it matches on both phones, nobody is listening in.
              It changes if either of you starts over with new keys.
            </Text>
          </>
        ) : (
          <Pressable onPress={() => setShowCode(true)} hitSlop={8}>
            <Text style={styles.link}>Verify security code</Text>
          </Pressable>
        ))}
      </View>
      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <SafeAreaView style={styles.scanner}>
          <View style={styles.scannerTop}>
            <Text style={styles.scannerTitle}>Scan the QR code in {otherName || 'their'}'s chat info</Text>
            <Pressable onPress={() => setScanning(false)} hitSlop={10} accessibilityLabel="Close"><X size={24} color={colors.white} /></Pressable>
          </View>
          {scanning && (
            <Camera style={styles.flex} cameraType={CameraType.Back} scanBarcode showFrame laserColor={colors.primary500} frameColor={colors.white}
              onReadCode={(e) => onRead(e.nativeEvent.codeStringValue)} />
          )}
        </SafeAreaView>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space(4), paddingHorizontal: space(4), paddingVertical: space(3.5) },
  flex: { flex: 1 },
  title: { fontSize: 15, color: colors.muted900 },
  text: { fontSize: 12, color: colors.muted500, marginTop: 2 },
  link: { fontSize: 13, color: colors.primary700, fontWeight: '600', marginTop: space(1.5) },
  verified: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: space(1.5) },
  verifiedText: { fontSize: 13, fontWeight: '600', color: colors.success700 },
  qr: { alignSelf: 'flex-start', padding: space(2), marginTop: space(3), backgroundColor: colors.white, borderRadius: 8, borderWidth: 1, borderColor: colors.muted200 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(4), marginTop: space(3) },
  action: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  linkInline: { fontSize: 13, color: colors.primary700, fontWeight: '600' },
  scanner: { flex: 1, backgroundColor: '#000' },
  scannerTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: space(4), gap: space(3) },
  scannerTitle: { flex: 1, color: colors.white, fontSize: 16, fontWeight: '600' },
  code: { fontFamily: 'monospace', fontSize: 15, letterSpacing: 1, color: colors.muted900, marginTop: space(2), lineHeight: 22 },
});

export default EncryptionInfo;
