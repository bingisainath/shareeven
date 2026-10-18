// src/app/RequireAuth.tsx
import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { Loading } from '../components/atoms';
import { E2EGate } from './E2EGate';
import { TabGate } from './TabGate';

interface RequireAuthProps {
  children: React.ReactNode;
}

export const RequireAuth: React.FC<RequireAuthProps> = ({ children }) => {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  // Show loading spinner while checking authentication
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-muted-50">
        <Loading variant="spinner" size="xl" text="Loading..." />
      </div>
    );
  }

  // Redirect to login if not authenticated
  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Render protected content in the active tab, once this browser has the account's encryption keys
  return <TabGate><E2EGate>{children}</E2EGate></TabGate>;
};