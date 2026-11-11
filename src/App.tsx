import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Index from "./pages/Index";
import NotFound from "./pages/NotFound";
import Intake from "./pages/Intake";
import Queue from "./pages/Queue";
import Calendar from "./pages/Calendar";
import Visit from "./pages/Visit";
import Auth from "./pages/Auth";
import Billing from "./pages/Billing";
import Expenses from "./pages/Expenses";
import PatientManagement from "./pages/PatientManagement";
import Exports from "./pages/Exports";
import AdminSettings from "./pages/AdminSettings";
import Reports from "./pages/Reports";
import LandingPage from "./pages/LandingPage";
import BookingRequests from "./pages/BookingRequests";
import AuditLog from "./pages/AuditLog";
import ChangePassword from "./pages/ChangePassword";
import ResetPassword from "./pages/ResetPassword";
import { AuthProvider } from "./hooks/useAuth";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { AuthFailureHandler } from "./components/AuthFailureHandler";
import { reportAuthFailure } from "./lib/api";

// Every query/mutation error passes by here: a 401 SESSION_EXPIRED or 403
// PASSWORD_CHANGE_REQUIRED from the query shim is handed to the
// AuthFailureHandler (apiFetch reports its own).
const onCacheError = (error: unknown) => reportAuthFailure(error as { code?: string; message?: string });

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onCacheError }),
  mutationCache: new MutationCache({ onError: onCacheError }),
});

const FINANCE = ["admin", "moderator"];

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <AuthFailureHandler />
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/auth" element={<Auth />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/change-password" element={<ProtectedRoute><ChangePassword /></ProtectedRoute>} />
            <Route path="/dashboard" element={<ProtectedRoute><Index /></ProtectedRoute>} />
            <Route path="/intake" element={<ProtectedRoute><Intake /></ProtectedRoute>} />
            <Route path="/queue" element={<ProtectedRoute><Queue /></ProtectedRoute>} />
            <Route path="/calendar" element={<ProtectedRoute><Calendar /></ProtectedRoute>} />
            <Route path="/visit/:id" element={<ProtectedRoute><Visit /></ProtectedRoute>} />
            <Route path="/patients" element={<ProtectedRoute><PatientManagement /></ProtectedRoute>} />
            <Route path="/bookings" element={<ProtectedRoute><BookingRequests /></ProtectedRoute>} />
            <Route path="/billing" element={<ProtectedRoute roles={FINANCE}><Billing /></ProtectedRoute>} />
            <Route path="/expenses" element={<ProtectedRoute roles={FINANCE}><Expenses /></ProtectedRoute>} />
            <Route path="/exports" element={<ProtectedRoute requireAdmin><Exports /></ProtectedRoute>} />
            <Route path="/reports" element={<ProtectedRoute requireAdmin><Reports /></ProtectedRoute>} />
            <Route path="/admin/audit" element={<ProtectedRoute requireAdmin><AuditLog /></ProtectedRoute>} />
            <Route path="/admin/settings" element={<ProtectedRoute requireAdmin><AdminSettings /></ProtectedRoute>} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
