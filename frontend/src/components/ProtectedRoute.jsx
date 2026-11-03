import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { EmptyState, FullPageSpinner } from './medis';

/**
 * Wrap any page that requires login.
 * Pass allowedRoles to also restrict by role, e.g.:
 *   <ProtectedRoute allowedRoles={['doctor']}><DoctorLayout /></ProtectedRoute>
 *
 * - Not logged in              -> redirect to /login
 * - Logged in, wrong role      -> redirect to their own dashboard
 * - Logged in, profile missing -> show a simple error (shouldn't normally happen)
 */
export function ProtectedRoute({ children, allowedRoles }) {
  const { session, profile, role, loading } = useAuth();

  if (loading) {
    return <FullPageSpinner />;
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  if (!profile) {
    return (
      <div className="mx-auto max-w-md px-4 py-10">
        <EmptyState text="Your account is set up but your profile wasn't found. Please contact support or try logging in again." />
      </div>
    );
  }

  if (allowedRoles && !allowedRoles.includes(role)) {
    // Logged in, but trying to access the wrong dashboard — send them home
    return <Navigate to={role === 'doctor' ? '/doctor' : '/patient'} replace />;
  }

  return children;
}
