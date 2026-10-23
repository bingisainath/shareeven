// src/components/Composer.tsx
// Message box like the web app's: text, attachments (camera, photos & videos, documents) with a
// caption each, and voice notes. An empty box shows a microphone instead of Send. Pasted images and
// files (Android) are added as attachments too (src/share/paste.ts).
import React, { useEffect, useRef, useState } from 'react';
import { Image, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Asset, launchCamera, launchImageLibrary } from 'react-native-image-picker';
import { cameraAllowed } from '../../utils/camera';
import { keepLocalCopy, pick, types } from '@react-native-documents/picker';
import { Camera, FileText, Image as ImageIcon, Mic, Paperclip, Play, SendHorizontal, Trash2, X } from 'lucide-react-native';
import { ALLOWED, fileProblem, kindOf, UploadQuality } from '../../api/media';
import type { Attachment } from '../../store/chat';
import { useVoiceRecorder } from '../../hooks/useVoiceRecorder';
import { colors, radius, space } from '../../theme';
import { formatDuration } from '../../utils/time';
import { showAlert } from '../common/Dialog';
import { MESSAGE_INPUT_ID, onPastedFiles, pastedAttachment } from '../../share/paste';
import type { PastedFile } from '../../share/paste';

const MAX = 10;

interface Draft extends Attachment {
  id: string;
}

interface Props {
  text: string;
  onChangeText: (text: string) => void;
  editing: boolean;
  onSendText: () => void;
  onSendAttachments: (attachments: Attachment[]) => void;
  onSendVoice: (attachment: Attachment) => void;
}

let counter = 0;

const fromAsset = (asset: Asset, hd: boolean): Draft | null => {
  const type = asset.type || (asset.uri?.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg');
  const problem = fileProblem(type, asset.fileSize);
  if (!asset.uri || problem) {
    showAlert(asset.fileName || 'File', problem || "This file couldn't be read");
    return null;
  }
  const kind = ALLOWED[type];
  return {
    id: `a${++counter}`,
    file: { uri: asset.uri, type, name: asset.fileName || `${kind}-${Date.now()}` },
    kind,
    caption: '',
    quality: kind === 'video' && hd ? 'hd' : 'standard',
    size: asset.fileSize,
    width: asset.width,
    height: asset.height,
    duration: asset.duration ? Math.round(asset.duration) : undefined,
  };
};

const Composer: React.FC<Props> = ({ text, onChangeText, editing, onSendText, onSendAttachments, onSendVoice }) => {
  const [menu, setMenu] = useState(false);
  const [hd, setHd] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [selected, setSelected] = useState(0);
  const recorder = useVoiceRecorder(({ uri, seconds }) => onSendVoice({
    file: { uri, type: 'audio/mp4', name: `voice-note-${Date.now()}.m4a` },
    kind: 'audio', caption: '', quality: 'original', duration: seconds,
  }));

  const add = (list: Draft[]) => {
    if (!list.length) return;
    const room = MAX - drafts.length;
    if (list.length > room) showAlert(`You can send up to ${MAX} at once`);
    // the text box becomes the caption of the selected attachment
    if (!drafts.length) { setSelected(0); list[0].caption = text; onChangeText(''); }
    setDrafts((d) => [...d, ...list.slice(0, room)]);
  };

  // Pasted images and files become attachments like picked ones (not while editing a sent message)
  const addPasted = useRef<(files: PastedFile[]) => void>(() => undefined);
  addPasted.current = (files) => {
    if (editing) return;
    const list: Draft[] = [];
    for (const f of files) {
      const result = pastedAttachment(f);
      if ('problem' in result) showAlert(f.name || 'File', result.problem);
      else list.push({ ...result, id: `a${++counter}` });
    }
    add(list);
  };
  useEffect(() => onPastedFiles((files) => addPasted.current(files)), []);

  // Android's camera opens for a photo or for a video, never both ('mixed' only takes photos there): ask which
  const openCamera = () => {
    setMenu(false);
    if (Platform.OS !== 'android') {
      pickMedia('camera');
      return;
    }
    showAlert('Camera', undefined, [
      { text: 'Take photo', onPress: () => pickMedia('camera', 'photo') },
      { text: 'Record video', onPress: () => pickMedia('camera', 'video') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const pickMedia = async (source: 'camera' | 'library', only?: 'photo' | 'video') => {
    setMenu(false);
    const options = {
      mediaType: only || ('mixed' as const),
      maxWidth: hd ? 4096 : 1600, // photos are shrunk like WhatsApp unless HD is on
      maxHeight: hd ? 4096 : 1600,
      quality: (hd ? 0.9 : 0.8) as 0.9 | 0.8,
    };
    if (source === 'camera' && !(await cameraAllowed())) return;
    const result = source === 'camera'
      ? await launchCamera(options)
      : await launchImageLibrary({ ...options, selectionLimit: MAX - drafts.length });
    if (result.errorCode) showAlert("Couldn't open the " + (source === 'camera' ? 'camera' : 'gallery'), result.errorMessage || result.errorCode);
    add((result.assets || []).map((a) => fromAsset(a, hd)).filter((d): d is Draft => !!d));
  };

  const pickDocuments = async () => {
    setMenu(false);
    try {
      const files = await pick({ allowMultiSelection: true, type: [types.allFiles] });
      const copies = await keepLocalCopy({
        files: files.map((f) => ({ uri: f.uri, fileName: f.name || 'document' })) as [{ uri: string; fileName: string }],
        destination: 'cachesDirectory',
      });
      const list: Draft[] = [];
      files.forEach((f, i) => {
        const copy = copies[i];
        const type = f.type || 'application/octet-stream';
        const problem = fileProblem(type, f.size, true);
        if (problem || copy?.status !== 'success') {
          showAlert(f.name || 'File', problem || "This file couldn't be read");
          return;
        }
        list.push({
          id: `a${++counter}`,
          file: { uri: copy.localUri, type, name: f.name || 'document' },
          kind: kindOf(type, true)!, caption: '', quality: 'original' as UploadQuality, size: f.size || undefined,
        });
      });
      add(list);
    } catch (e: any) {
      if (e?.code !== 'OPERATION_CANCELED') showAlert("Couldn't open your files");
    }
  };

  const selectDraft = (i: number) => {
    setDrafts((d) => d.map((x, n) => (n === selected ? { ...x, caption: text } : x)));
    setSelected(i);
    onChangeText(drafts[i]?.caption || '');
  };

  const removeDraft = (i: number) => {
    const rest = drafts.filter((_, n) => n !== i);
    setDrafts(rest);
    const next = Math.max(0, Math.min(selected, rest.length - 1));
    setSelected(next);
    if (i === selected) onChangeText(rest[next]?.caption || '');
  };

  const send = () => {
    if (drafts.length) {
      onSendAttachments(drafts.map((d, i) => ({ ...d, caption: (i === selected ? text : d.caption).trim() })));
      setDrafts([]);
      onChangeText('');
      return;
    }
    onSendText();
  };

  if (recorder.recording) {
    return (
      <View style={styles.bar}>
        <Pressable onPress={() => recorder.stop(false)} hitSlop={8} style={styles.tool} accessibilityLabel="Delete recording">
          <Trash2 size={22} color={colors.danger600} />
        </Pressable>
        <View style={styles.recording}>
          <View style={styles.dot} />
          <Text style={styles.recordTime}>{formatDuration(recorder.seconds)}</Text>
          <Text style={styles.recordHint} numberOfLines={1}>Recording voice message…</Text>
        </View>
        <Pressable onPress={() => recorder.stop(true)} style={styles.send} accessibilityLabel="Send voice message">
          <SendHorizontal size={20} color={colors.white} />
        </Pressable>
      </View>
    );
  }

  const current = drafts[selected];
  const showMic = !editing && !drafts.length && !text.trim();

  return (
    <View>
      {drafts.length > 0 && (
        <View style={styles.tray}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.trayRow}>
            {drafts.map((d, i) => (
              <Pressable key={d.id} onPress={() => selectDraft(i)} style={[styles.thumb, i === selected && styles.thumbOn]}
                accessibilityLabel={`Attachment ${i + 1}: ${d.file.name}`}>
                {d.kind === 'image' ? (
                  <Image source={{ uri: d.file.uri }} style={styles.thumbImage} />
                ) : (
                  <View style={[styles.thumbImage, styles.thumbOther]}>
                    {d.kind === 'video' ? <Play size={20} color={colors.white} fill={colors.white} /> : <FileText size={22} color={colors.primary700} />}
                    {d.kind === 'video' && !!d.duration && <Text style={styles.thumbText}>{formatDuration(d.duration)}</Text>}
                  </View>
                )}
                <Pressable onPress={() => removeDraft(i)} hitSlop={6} style={styles.remove} accessibilityLabel={`Remove ${d.file.name}`}>
                  <X size={12} color={colors.white} />
                </Pressable>
              </Pressable>
            ))}
          </ScrollView>
          <Text style={styles.trayInfo} numberOfLines={1}>
            {current?.file.name}{current?.quality === 'original' ? ' · sent as a document' : current?.quality === 'hd' ? ' · HD' : ''}
          </Text>
        </View>
      )}

      <View style={styles.bar}>
        {!editing && (
          <Pressable onPress={() => setMenu(true)} hitSlop={6} style={styles.tool} accessibilityLabel="Attach">
            <Paperclip size={22} color={colors.primary700} />
          </Pressable>
        )}
        <TextInput
          value={text}
          onChangeText={onChangeText}
          placeholder={drafts.length ? 'Add a caption…' : 'Message'}
          placeholderTextColor={colors.muted400}
          multiline
          maxLength={5000}
          style={styles.input}
          accessibilityLabel="Message"
          nativeID={MESSAGE_INPUT_ID}
        />
        {showMic ? (
          <Pressable onPress={async () => { const problem = await recorder.start(); if (problem) showAlert(problem); }}
            style={styles.send} accessibilityLabel="Record voice message">
            <Mic size={20} color={colors.white} />
          </Pressable>
        ) : (
          <Pressable onPress={send} style={styles.send} accessibilityLabel={editing ? 'Save' : 'Send'}>
            <SendHorizontal size={20} color={colors.white} />
          </Pressable>
        )}
      </View>

      <Modal visible={menu} transparent animationType="fade" onRequestClose={() => setMenu(false)}>
        <Pressable style={styles.backdrop} onPress={() => setMenu(false)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <MenuRow icon={Camera} title="Camera" hint="Take a photo or video" onPress={openCamera} />
            <MenuRow icon={ImageIcon} title="Photos & videos" hint={`Up to ${MAX} at once`} onPress={() => pickMedia('library')} />
            <MenuRow icon={FileText} title="Document" hint="Any file up to 150 MB, or an image at full quality" onPress={pickDocuments} />
            <View style={styles.hdRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.menuTitle}>HD quality</Text>
                <Text style={styles.menuHint}>Sharper photos and videos, bigger files</Text>
              </View>
              <Switch value={hd} onValueChange={setHd} trackColor={{ true: colors.primary600, false: colors.muted300 }} thumbColor={colors.white} />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
};

const MenuRow: React.FC<{ icon: React.ComponentType<{ size?: number; color?: string }>; title: string; hint: string; onPress: () => void }> = ({ icon: Icon, title, hint, onPress }) => (
  <Pressable onPress={onPress} style={({ pressed }) => [styles.menuRow, pressed && { backgroundColor: colors.muted50 }]}>
    <View style={styles.menuIcon}><Icon size={22} color={colors.primary700} /></View>
    <View style={{ flex: 1 }}>
      <Text style={styles.menuTitle}>{title}</Text>
      <Text style={styles.menuHint}>{hint}</Text>
    </View>
  </Pressable>
);

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'flex-end', gap: space(2), paddingHorizontal: space(3), paddingVertical: space(2), backgroundColor: colors.white, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.muted200 },
  tool: { height: 44, justifyContent: 'center', paddingHorizontal: space(1) },
  input: { flex: 1, minHeight: 44, maxHeight: 140, paddingHorizontal: space(4), paddingTop: 11, paddingBottom: 11, borderRadius: 22, backgroundColor: colors.muted100, fontSize: 16, color: colors.muted900 },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.primary700, alignItems: 'center', justifyContent: 'center' },
  recording: { flex: 1, height: 44, flexDirection: 'row', alignItems: 'center', gap: space(2.5), paddingHorizontal: space(4), borderRadius: 22, backgroundColor: colors.muted100 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.danger500 },
  recordTime: { fontSize: 15, fontWeight: '600', color: colors.muted900, fontVariant: ['tabular-nums'] },
  recordHint: { flex: 1, fontSize: 14, color: colors.muted500 },
  tray: { backgroundColor: colors.muted50, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.muted200, paddingVertical: space(2) },
  trayRow: { gap: space(2), paddingHorizontal: space(3) },
  thumb: { width: 64, height: 64, borderRadius: radius.md, borderWidth: 2, borderColor: 'transparent', overflow: 'visible' },
  thumbOn: { borderColor: colors.primary600 },
  thumbImage: { width: '100%', height: '100%', borderRadius: radius.md - 2 },
  thumbOther: { backgroundColor: colors.muted700, alignItems: 'center', justifyContent: 'center' },
  thumbText: { color: colors.white, fontSize: 10, marginTop: 2 },
  remove: { position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: 10, backgroundColor: colors.muted900, alignItems: 'center', justifyContent: 'center' },
  trayInfo: { marginTop: space(1.5), paddingHorizontal: space(3), fontSize: 12, color: colors.muted500 },
  backdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.4)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.white, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingVertical: space(3), paddingBottom: space(8) },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: space(4), paddingHorizontal: space(5), paddingVertical: space(3) },
  menuIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.primary50, alignItems: 'center', justifyContent: 'center' },
  menuTitle: { fontSize: 16, color: colors.muted900, fontWeight: '500' },
  menuHint: { fontSize: 13, color: colors.muted500 },
  hdRow: { flexDirection: 'row', alignItems: 'center', gap: space(3), marginTop: space(2), paddingHorizontal: space(5), paddingTop: space(3), borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.muted200 },
});

export default Composer;
