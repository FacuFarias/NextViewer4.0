import { BrowserRouter, Routes, Route } from 'react-router-dom';
import DicomViewer from './components/DicomViewer';
import ConfigPage from './components/ConfigPage';
import AdminRoute from './components/AdminRoute';
import './App.css';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<DicomViewer />} />
        <Route path="/viewer/:studyInstanceUID" element={<DicomViewer />} />
        <Route
          path="/config"
          element={
            <AdminRoute>
              <ConfigPage />
            </AdminRoute>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
