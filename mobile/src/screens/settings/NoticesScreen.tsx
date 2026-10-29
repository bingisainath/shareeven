// src/screens/settings/NoticesScreen.tsx
// Settings → Notices: messages from the ShareEven team (a warning, or the outcome of a report you
// made). Opening it reads them. Same as web/src/components/organisms/Notices.tsx.
import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { CircleAlert, Inbox, MessageSquareText } from 'lucide-react-native';
import { Empty } from '../../components/common/ui';
import { useNotices } from '../../store/notices';
import { colors, radius, space } from '../../theme';

const NoticesScreen: React.FC = () => {
  const { notices, loaded, load, readAll } = useNotices();
  const [refreshing, setRefreshing] = useState(false);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  // Read once they're shown (and again if one arrives while this screen is open)
  useEffect(() => { if (loaded) readAll(); }, [loaded, notices.length, readAll]);

  return (
    <ScrollView contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
      {loaded && !notices.length && (
        <Empty icon={Inbox} title="No notices" text="Replies to your support requests, updates on reports you make, and warnings appear here." />
      )}
      {notices.map((n) => {
        const warning = n.kind === 'warning';
        const Icon = warning ? CircleAlert : MessageSquareText;
        return (
          <View key={n.id} style={[styles.card, warning && styles.warning]}>
            <Icon size={20} color={warning ? colors.warning700 : colors.primary700} />
            <View style={styles.flex}>
              <Text style={styles.title}>{n.title}</Text>
              <Text style={styles.date}>{new Date(n.created_at).toLocaleString()}</Text>
              <Text style={styles.body}>{n.body}</Text>
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  content: { padding: space(4), gap: space(3) },
  card: {
    flexDirection: 'row', gap: space(3), padding: space(4), borderRadius: radius.lg,
    backgroundColor: colors.white, borderWidth: 1, borderColor: colors.muted200,
  },
  warning: { backgroundColor: colors.warning50, borderColor: '#fde68a' },
  flex: { flex: 1 },
  title: { fontSize: 15, fontWeight: '600', color: colors.muted900 },
  date: { fontSize: 12, color: colors.muted400, marginTop: 2 },
  body: { fontSize: 14, color: colors.muted700, marginTop: space(2), lineHeight: 20 },
});

export default NoticesScreen;
