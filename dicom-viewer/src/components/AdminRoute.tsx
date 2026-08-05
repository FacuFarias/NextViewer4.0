import React, { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { DICOM_PASSWORD, DICOM_USERNAME, isAdmin, getCurrentToken, getAccessToken } from '../services/auth';
import { useTranslation } from '../i18n';

interface AdminRouteProps {
  children: React.ReactNode;
}

const AdminRoute: React.FC<AdminRouteProps> = ({ children }) => {
  const { t } = useTranslation();
  const [isChecking, setIsChecking] = useState(true);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const location = useLocation();

  useEffect(() => {
    const checkAuth = async () => {
      try {
        let token = getCurrentToken();
        
        if (!token) {
          try {
            token = await getAccessToken(DICOM_USERNAME, DICOM_PASSWORD);
          } catch {
            setIsAuthorized(false);
            setIsChecking(false);
            return;
          }
        }

        if (isAdmin()) {
          setIsAuthorized(true);
        } else {
          setIsAuthorized(false);
        }
      } catch (error) {
        console.error('Auth check failed:', error);
        setIsAuthorized(false);
      } finally {
        setIsChecking(false);
      }
    };

    checkAuth();
  }, []);

  if (isChecking) {
    return (
      <div className="admin-loading">
        <div className="loading-spinner"></div>
        <p>{t('admin.checkingPermissions')}</p>
      </div>
    );
  }

  if (!isAuthorized) {
    return <Navigate to="/" state={{ from: location }} replace />;
  }

  return <>{children}</>;
};

export default AdminRoute;
