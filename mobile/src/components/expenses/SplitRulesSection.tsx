// src/components/expenses/SplitRulesSection.tsx
// A chat's split rules (chat info screen): items of a category go to the same people whenever a
// receipt is scanned. Same as the web's SplitRulesSettings.
import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import Avatar from '../common/Avatar';
import { Button } from '../common/ui';
import { showAlert } from '../common/Dialog';
import { errorMessage } from '../../api/client';
import { expenseService, SplitRules } from '../../api/expenses';
import type { MemberInfo } from '../../api/chat';
import { memberName } from '../../hooks/useMembers';
import { RECEIPT_CATEGORIES, categoryLabel } from '../../utils/receiptCategories';
import { colors, radius, space } from '../../theme';

type Editing = { category: string; user_ids: string[]; isNew: boolean };

const SplitRulesSection: React.FC<{ conversationId: string; members: MemberInfo[] }> = ({ conversationId, members }) => {
  const [rules, setRules] = useState<SplitRules | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);

  useEffect(() => {
    expenseService.splitRules(conversationId).then(setRules).catch(() => undefined);
  }, [conversationId]);

  if (!rules) return null;
  const nameOf = (id: string) => memberName(members.find((m) => m.id === id)).split(' ')[0] || 'Someone';
  const who = (ids: string[]) => (ids.length ? ids.map(nameOf).join(', ') : 'Everyone, equally');
  const current = rules.rules.map((r) => ({ category: r.category, user_ids: r.user_ids }));
  const unused = RECEIPT_CATEGORIES.filter((c) => !rules.rules.some((r) => r.category === c.key));
  const save = async (next: { category: string; user_ids: string[] }[]) => {
    try {
      setRules(await expenseService.updateSplitRules(conversationId, next));
      setEditing(null);
    } catch (e) {
      showAlert("Couldn't save the rule", errorMessage(e));
    }
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Split rules</Text>
      <Text style={styles.hint}>When a receipt is scanned, items in these categories go to the same people. You can still change any item.</Text>
      {rules.rules.map((r) => (
        <Pressable key={r.category} disabled={!rules.can_edit} onPress={() => setEditing({ category: r.category, user_ids: r.user_ids, isNew: false })}
          style={styles.rule} accessibilityLabel={`${r.label}: ${who(r.user_ids)}`}>
          <View style={{ flex: 1 }}>
            <Text style={styles.ruleName}>{r.label}</Text>
            <Text style={styles.ruleWho} numberOfLines={1}>{who(r.user_ids)}</Text>
          </View>
          {rules.can_edit && <Text style={styles.edit}>Edit</Text>}
        </Pressable>
      ))}
      {rules.can_edit && unused.length > 0 && (
        <Pressable onPress={() => setEditing({ category: unused[0].key, user_ids: [], isNew: true })} style={styles.add} accessibilityLabel="Add a split rule">
          <Text style={styles.addText}>+ Add a rule</Text>
        </Pressable>
      )}
      {!rules.can_edit && rules.rules.length === 0 && <Text style={styles.hint}>No rules yet. Group admins can add them.</Text>}

      {editing && (
        <Modal visible transparent animationType="slide" onRequestClose={() => setEditing(null)}>
          <View style={styles.backdrop}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setEditing(null)} accessibilityLabel="Close" />
            <View style={styles.sheet}>
              <Text style={styles.sheetTitle}>{editing.isNew ? 'New split rule' : categoryLabel(editing.category)}</Text>
              <ScrollView contentContainerStyle={{ gap: space(3) }}>
                {editing.isNew && (
                  <View style={styles.chips}>
                    {unused.map((c) => {
                      const on = editing.category === c.key;
                      return (
                        <Pressable key={c.key} onPress={() => setEditing({ ...editing, category: c.key })} style={[styles.chip, on && styles.chipOn]} accessibilityState={{ selected: on }}>
                          <Text style={[styles.chipText, on && styles.chipTextOn]}>{c.label}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                )}
                <Text style={styles.hint}>Who are these items for? Pick nobody for everyone, split equally.</Text>
                {members.map((m) => {
                  const on = editing.user_ids.includes(m.id);
                  return (
                    <View key={m.id} style={styles.person}>
                      <Avatar uri={m.avatar} name={memberName(m)} size={28} />
                      <Text style={styles.personName} numberOfLines={1}>{memberName(m)}</Text>
                      <Switch value={on} trackColor={{ true: colors.primary600, false: colors.muted300 }} thumbColor={colors.white}
                        accessibilityLabel={`${memberName(m)} gets these items`}
                        onValueChange={(v) => setEditing({ ...editing, user_ids: v ? [...editing.user_ids, m.id] : editing.user_ids.filter((u) => u !== m.id) })} />
                    </View>
                  );
                })}
              </ScrollView>
              <View style={styles.footer}>
                {!editing.isNew && <Button title="Remove" variant="danger" compact onPress={() => save(current.filter((x) => x.category !== editing.category))} />}
                <View style={{ flex: 1 }} />
                <Button title="Cancel" variant="secondary" compact onPress={() => setEditing(null)} />
                <Button title="Save" compact onPress={() => save([...current.filter((x) => x.category !== editing.category), { category: editing.category, user_ids: editing.user_ids }])} />
              </View>
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: space(4), paddingVertical: space(3), gap: space(2) },
  title: { fontSize: 15, fontWeight: '600', color: colors.muted900 },
  hint: { fontSize: 12, color: colors.muted500 },
  rule: { flexDirection: 'row', alignItems: 'center', gap: space(2), paddingVertical: space(2), paddingHorizontal: space(3), borderRadius: radius.md, borderWidth: 1, borderColor: colors.muted200 },
  ruleName: { fontSize: 14, fontWeight: '600', color: colors.muted900 },
  ruleWho: { fontSize: 12, color: colors.muted500, marginTop: 1 },
  edit: { fontSize: 13, fontWeight: '600', color: colors.primary700 },
  add: { height: 38, borderRadius: radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.primary300, alignItems: 'center', justifyContent: 'center' },
  addText: { fontSize: 13, fontWeight: '600', color: colors.primary700 },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15, 10, 25, 0.45)' },
  sheet: { maxHeight: '85%', backgroundColor: colors.white, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: space(4), gap: space(3) },
  sheetTitle: { fontSize: 17, fontWeight: '700', color: colors.muted900 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(1.5) },
  chip: { paddingHorizontal: space(2.5), paddingVertical: 5, borderRadius: radius.full, borderWidth: 1, borderColor: colors.muted200 },
  chipOn: { borderColor: colors.primary600, backgroundColor: colors.primary50 },
  chipText: { fontSize: 12, color: colors.muted600 },
  chipTextOn: { color: colors.primary700, fontWeight: '600' },
  person: { flexDirection: 'row', alignItems: 'center', gap: space(3) },
  personName: { flex: 1, fontSize: 15, color: colors.muted900 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
});

export default SplitRulesSection;
