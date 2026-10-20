// src/navigation/RootNavigator.tsx
import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
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

const AuthStack = createNativeStackNavigator<AuthStackParams>();
const AppStack = createNativeStackNavigator<AppStackParams>();
const Tab = createBottomTabNavigator<TabParams>();

const headerStyle = {
  headerTintColor: colors.primary700,
  headerTitleStyle: { color: colors.muted900, fontWeight: '700' as const },
  headerStyle: { backgroundColor: colors.white },
  headerShadowVisible: true,
  contentStyle: { backgroundColor: colors.background },
};

const Tabs: React.FC = () => {
  const unread = useChat(s =>
    // Muted and archived chats don't count (like WhatsApp)
    s.conversations.reduce((sum, c) => sum + (c.unreadCount > 0 && !c.isArchived && !isMuted(c) ? 1 : 0), 0),
  );
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary700,
        tabBarInactiveTintColor: colors.muted500,
        tabBarStyle: {
          backgroundColor: colors.white,
          borderTopColor: colors.muted200,
          minHeight: 64,
          paddingTop: 6,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
      }}
    >
      <Tab.Screen
        name="Chats"
        component={ChatListScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <MessagesSquare color={color} size={size} />
          ),
          tabBarBadge: unread ? unread : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.primary700 },
        }}
      />
      <Tab.Screen
        name="Expenses"
        component={ExpensesHomeScreen}
        options={{
          tabBarIcon: ({ color, size }) => <Wallet color={color} size={size} />,
        }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <Settings color={color} size={size} />
          ),
        }}
      />
    </Tab.Navigator>
  );
};

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
