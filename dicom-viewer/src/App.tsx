import { BrowserRouter, Routes, Route } from 'react-router-dom';
import DicomViewer from './components/DicomViewer';
import ConfigPage from './components/ConfigPage';
import AdminRoute from './components/AdminRoute';
import { LanguageProvider } from './i18n';
import './App.css';

function App() {
  return (
    <LanguageProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<DicomViewer key="studies-route" />} />
          <Route
            path="/viewer/:studyInstanceUID"
            element={<DicomViewer key="viewer-route" />}
          />
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
    </LanguageProvider>
  );
}

export default App;
