import { Navigate, useLocation } from 'react-router-dom';

// Preserve bookmarks and overview links to the former search page.
export default function PatientSearch() {
  const { search } = useLocation();
  return <Navigate to={`/doctor/patients${search}`} replace />;
}
