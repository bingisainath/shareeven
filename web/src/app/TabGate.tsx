// src/app/TabGate.tsx
// The chats run in one tab per browser (see utils/activeTab). Any other tab shows this card
// until "Use here" moves them to it.

import React, { useEffect, useState } from 'react';
import { MonitorSmartphone } from 'lucide-react';
import { Loading } from '../components/atoms';
import { activeTabState, onActiveTabChange, takeOverTab } from '../utils/activeTab';

export const TabGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState(activeTabState);
  useEffect(() => onActiveTabChange(setState), []);

  if (state === 'active') return <>{children}</>;
  if (state === 'checking') {
    return (
      <div className="flex items-center justify-center h-screen bg-muted-50">
        <Loading variant="spinner" size="xl" text="Loading…" />
      </div>
    );
  }
  return (
    <div className="min-h-screen flex items-center justify-center bg-muted-50 p-4">
      <div className="bg-white border border-muted-200 rounded-2xl shadow-card p-8 w-full max-w-md text-center" role="alert">
        <div className="w-14 h-14 mx-auto mb-5 rounded-full bg-primary-50 flex items-center justify-center">
          <MonitorSmartphone className="w-7 h-7 text-primary-700" strokeWidth={1.75} />
        </div>
        <h1 className="text-2xl font-semibold text-muted-900">ShareEven is open in another tab</h1>
        <p className="mt-2 text-sm text-muted-600">
          Your chats run in one tab at a time, so your encrypted messages stay readable. Use them here instead?
        </p>
        <button type="button" onClick={() => takeOverTab()} className="mt-6 w-full py-3 rounded-lg bg-primary-700 hover:bg-primary-800 text-white font-medium">
          Use here
        </button>
      </div>
    </div>
  );
};
