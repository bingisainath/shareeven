// src/navigation/RootNavigator.tsx
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createMaterialTopTabNavigator } from '@react-navigation/material-top-tabs';
import type { MaterialTopTabBarProps } from '@react-navigation/material-top-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessagesSquare, Settings, Wallet } from 'lucide-react-native';
import OfflineBanner from '../components/common/OfflineBanner';
import { useAuth } from '../store/auth';
import { useChat } from '../store/chat';
import { isMuted } from '../api/chat';
import { colors } from '../theme';
import type { AppStackParams, AuthStackParams, TabParams } from './types';
import LoginScreen from '../screens/auth/LoginScreen';
import SignUpScreen from '../screens/auth/SignUpScreen';
import VerifyEmailScreen from '../screens/auth/VerifyEmailScreen';
import ForgotPasswordScreen from '../screens/auth/ForgotPasswordScreen';
import ChatListScreen from '../screens/chats/ChatListScreen';
import ChatScreen from '../screens/chats/ChatScreen';
import ChatInfoScreen from '../screens/chats/ChatInfoScreen';
import SharedMediaScreen from '../screens/chats/SharedMediaScreen';
import NewChatScreen from '../screens/chats/NewChatScreen';
import NewGroupScreen from '../screens/chats/NewGroupScreen';
import ExpensesHomeScreen from '../screens/expenses/ExpensesHomeScreen';
import ChatExpensesScreen from '../screens/expenses/ChatExpensesScreen';
import AddExpenseScreen from '../screens/expenses/AddExpenseScreen';
import ScanReceiptScreen from '../screens/expenses/ScanReceiptScreen';
import ExpenseDetailScreen from '../screens/expenses/ExpenseDetailScreen';
import SettingsScreen from '../screens/settings/SettingsScreen';
import AccountScreen from '../screens/settings/AccountScreen';
import BackupScreen from '../screens/settings/BackupScreen';
import ReceiptScanningScreen from '../screens/settings/ReceiptScanningScreen';
import PlanScreen from '../screens/settings/PlanScreen';
import HelpScreen from '../screens/settings/HelpScreen';
import ProfileScreen from '../screens/settings/ProfileScreen';
import StoreDiscountsScreen from '../screens/settings/StoreDiscountsScreen';
import E2EGate from '../screens/auth/E2EGate';
import SessionsScreen from '../screens/settings/SessionsScreen';
import EncryptionScreen from '../screens/settings/EncryptionScreen';
import DeleteAccountScreen from '../screens/settings/DeleteAccountScreen';
import LinkApprovalPrompt from '../components/settings/LinkApprovalPrompt';
import BlockedPeopleScreen from '../screens/settings/BlockedPeopleScreen';
import NoticesScreen from '../screens/settings/NoticesScreen';
import ReportScreen from '../screens/settings/ReportScreen';
import SupportScreen from '../screens/settings/SupportScreen';

const AuthStack = createNativeStackNavigator<AuthStackParams>();
const AppStack = createNativeStackNavigator<AppStackParams>();
// Swipeable tabs (like WhatsApp): a pager with the tab bar at the bottom
const Tab = createMaterialTopTabNavigator<TabParams>();

const headerStyle = {
  headerTintColor: colors.primary700,
  headerTitleStyle: { color: colors.muted900, fontWeight: '700' as const },
  headerStyle: { backgroundColor: colors.white },
  headerShadowVisible: true,
  contentStyle: { backgroundColor: colors.background },
};

const TAB_ICONS = { Chats: MessagesSquare, Expenses: Wallet, Settings } as const;

const BottomTabBar: React.FC<MaterialTopTabBarProps> = ({ state, navigation }) => {
  const insets = useSafeAreaInsets();
  const unread = useChat(s =>
    // Muted and archived chats don't count (like WhatsApp)
    s.conversations.reduce((sum, c) => sum + (c.unreadCount > 0 && !c.isArchived && !isMuted(c) ? 1 : 0), 0),
  );
  return (
    <View style={[tabStyles.bar, { paddingBottom: Math.max(insets.bottom, 6) }]} accessibilityRole="tablist">
      {state.routes.map((route, index) => {
        const focused = state.index === index;
        const color = focused ? colors.primary700 : colors.muted500;
        const Icon = TAB_ICONS[route.name as keyof typeof TAB_ICONS];
        const badge = route.name === 'Chats' && unread ? unread : 0;
        const onPress = () => {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
        };
        return (
          <Pressable key={route.key} onPress={onPress} style={tabStyles.tab} accessibilityRole="tab"
            accessibilityState={{ selected: focused }} accessibilityLabel={badge ? `${route.name}, ${badge} unread` : route.name}>
            <View>
              <Icon color={color} size={24} />
              {!!badge && (
                <View style={tabStyles.badge}>
                  <Text style={tabStyles.badgeText}>{badge > 99 ? '99+' : badge}</Text>
                </View>
              )}
            </View>
            <Text style={[tabStyles.label, { color }]}>{route.name}</Text>
          </Pressable>
        );
      })}
    </View>
  );
};

const tabStyles = StyleSheet.create({
  bar: { flexDirection: 'row', backgroundColor: colors.white, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.muted200, paddingTop: 6 },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 52, gap: 2 },
  label: { fontSize: 11, fontWeight: '700' },
  badge: { position: 'absolute', top: -4, left: 14, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary700, borderWidth: 1.5, borderColor: colors.white },
  badgeText: { color: colors.white, fontSize: 10, fontWeight: '700' },
});

const Tabs: React.FC = () => (
  <Tab.Navigator
    tabBarPosition="bottom"
    tabBar={(props) => <BottomTabBar {...props} />}
    // Expenses and Settings load when first opened, not with the app
    screenOptions={{ lazy: true, swipeEnabled: true, sceneStyle: { backgroundColor: colors.background } }}
    backBehavior="initialRoute"
  >
    <Tab.Screen name="Chats" component={ChatListScreen} />
    <Tab.Screen name="Expenses" component={ExpensesHomeScreen} />
    <Tab.Screen name="Settings" component={SettingsScreen} />
  </Tab.Navigator>
);

const RootNavigator: React.FC = () => {
  const status = useAuth(s => s.status);
  const user = useAuth(s => s.user);

  if (status === 'loading') {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.background,
        }}
      >
        <ActivityIndicator color={colors.primary700} />
      </View>
    );
  }

  if (status === 'signedOut') {
    return (
      <AuthStack.Navigator
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <AuthStack.Screen name="Login" component={LoginScreen} />
        <AuthStack.Screen name="SignUp" component={SignUpScreen} />
        <AuthStack.Screen name="VerifyEmail" component={VerifyEmailScreen} />
        <AuthStack.Screen
          name="ForgotPassword"
          component={ForgotPasswordScreen}
        />
      </AuthStack.Navigator>
    );
  }

  return (
    <E2EGate>
      <View style={{ flex: 1 }}>
        <AppStack.Navigator screenOptions={headerStyle}>
          <AppStack.Screen
            name="Tabs"
            component={Tabs}
            options={{ headerShown: false }}
          />
          <AppStack.Screen
            name="Chat"
            component={ChatScreen}
            options={{ title: '' }}
          />
          <AppStack.Screen
            name="ChatInfo"
            component={ChatInfoScreen}
            options={{ title: 'Info' }}
          />
          <AppStack.Screen
            name="SharedMedia"
            component={SharedMediaScreen}
            options={{ title: 'Media, links and docs' }}
          />
          <AppStack.Screen
            name="NewChat"
            component={NewChatScreen}
            options={{ title: 'New chat' }}
          />
          <AppStack.Screen
            name="NewGroup"
            component={NewGroupScreen}
            options={{ title: 'New group' }}
          />
          <AppStack.Screen
            name="ChatExpenses"
            component={ChatExpensesScreen}
            options={{ title: 'Balances & expenses' }}
          />
          <AppStack.Screen
            name="AddExpense"
            component={AddExpenseScreen}
            options={{ title: 'Add expense', presentation: 'modal' }}
          />
          <AppStack.Screen
            name="ScanReceipt"
            component={ScanReceiptScreen}
            options={{ title: 'Scan receipt' }}
          />
          <AppStack.Screen
            name="ExpenseDetail"
            component={ExpenseDetailScreen}
            options={{ title: 'Expense' }}
          />
          <AppStack.Screen
            name="Profile"
            component={ProfileScreen}
            options={{ title: 'Profile' }}
          />
          <AppStack.Screen
            name="Account"
            component={AccountScreen}
            options={{ title: 'Account' }}
          />
          <AppStack.Screen
            name="Backup"
            component={BackupScreen}
            options={{ title: 'Encryption & backup' }}
          />
          <AppStack.Screen
            name="Plan"
            component={PlanScreen}
            options={{ title: 'ShareEven Pro' }}
          />
          <AppStack.Screen
            name="ReceiptScanning"
            component={ReceiptScanningScreen}
            options={{ title: 'Receipt scanning' }}
          />
          <AppStack.Screen
            name="Help"
            component={HelpScreen}
            options={{ title: 'Help & about' }}
          />
          <AppStack.Screen
            name="StoreDiscounts"
            component={StoreDiscountsScreen}
            options={{ title: 'Store discounts' }}
          />
          <AppStack.Screen
            name="Sessions"
            component={SessionsScreen}
            options={{ title: 'Sessions' }}
          />
          <AppStack.Screen
            name="DeleteAccount"
            component={DeleteAccountScreen}
            options={{ title: 'Delete account' }}
          />
          <AppStack.Screen
            name="BlockedPeople"
            component={BlockedPeopleScreen}
            options={{ title: 'Blocked people' }}
          />
          <AppStack.Screen
            name="Notices"
            component={NoticesScreen}
            options={{ title: 'Notices' }}
          />
          <AppStack.Screen
            name="Support"
            component={SupportScreen}
            options={{ title: 'Contact support' }}
          />
          <AppStack.Screen
            name="Report"
            component={ReportScreen}
            options={{ title: 'Report' }}
          />
          <AppStack.Screen
            name="Encryption"
            component={EncryptionScreen}
            options={{ title: 'Linked devices' }}
          />
        </AppStack.Navigator>
        <OfflineBanner />
        {!!user && <LinkApprovalPrompt userId={user.id} />}
      </View>
    </E2EGate>
  );
};

export default RootNavigator;
