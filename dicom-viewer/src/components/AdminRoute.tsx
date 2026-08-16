import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { isAdmin } from '../services/auth';

interface AdminRouteProps {
  children: React.ReactNode;
}

const AdminRoute: React.FC<AdminRouteProps> = ({ children }) => {
  const location = useLocation();

  if (!isAdmin()) {
    return <Navigate to="/" state={{ from: location }} replace />;
  }

  return <>{children}</>;
};

export default AdminRoute;
