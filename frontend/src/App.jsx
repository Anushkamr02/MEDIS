import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import Login from './pages/Login';
import Register from './pages/Register';
import PatientDashboard from './pages/PatientDashboard';
import Onboarding from './pages/Onboarding';
import DoctorLayout from './pages/doctor/DoctorLayout';
import DoctorOverview from './pages/doctor/DoctorOverview';
import PatientSearch from './pages/doctor/PatientSearch';
import MyPatients from './pages/doctor/MyPatients';
import PatientProfile from './pages/doctor/PatientProfile';
import NewConsultation from './pages/doctor/NewConsultation';
import DoctorAppointments from './pages/doctor/DoctorAppointments';
import Drafts from './pages/doctor/Drafts';
import DoctorProfile from './pages/doctor/DoctorProfile';
import MyProfile from './pages/MyProfile';
import PatientLayout from './pages/PatientLayout';
import PatientPrescriptions from './pages/patient/PatientPrescriptions';
import PatientDocuments from './pages/patient/PatientDocuments';
import PatientVisits from './pages/patient/PatientVisits';
import PatientAccess from './pages/patient/PatientAccess';
import { FullPageSpinner } from './components/medis';
import { Toaster } from './components/ui';

function RootRedirect() {
  const { session, role, loading } = useAuth();

  if (loading) return <FullPageSpinner />;
  if (!session) return <Navigate to="/login" replace />;
  return <Navigate to={role === 'doctor' ? '/doctor' : '/patient'} replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />

          {/* All patient pages render inside PatientLayout's <Outlet /> */}
          <Route
            path="/patient"
            element={
              <ProtectedRoute allowedRoles={['patient']}>
                <PatientLayout />
              </ProtectedRoute>
            }
          >
            {/* The five dashboard sections. Dashboard is the default. */}
            <Route index element={<PatientDashboard />} />
            <Route path="prescriptions" element={<PatientPrescriptions />} />
            <Route path="documents" element={<PatientDocuments />} />
            <Route path="visits" element={<PatientVisits />} />
            <Route path="access" element={<PatientAccess />} />
            <Route path="profile" element={<MyProfile />} />
            <Route path="onboarding" element={<Onboarding />} />
          </Route>

          {/* All doctor pages render inside DoctorLayout's <Outlet /> */}
          <Route
            path="/doctor"
            element={
              <ProtectedRoute allowedRoles={['doctor']}>
                <DoctorLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<DoctorOverview />} />
            <Route path="search" element={<PatientSearch />} />
            <Route path="patients" element={<MyPatients />} />
            <Route path="patients/:patientId" element={<PatientProfile />} />
            <Route path="patients/:patientId/consult" element={<NewConsultation key="start" />} />
            <Route path="consultations/:consultationId" element={<NewConsultation key="edit" />} />
            <Route path="appointments" element={<DoctorAppointments />} />
            <Route path="drafts" element={<Drafts />} />
            <Route path="profile" element={<DoctorProfile />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <Toaster richColors position="top-center" />
      </BrowserRouter>
    </AuthProvider>
  );
}
