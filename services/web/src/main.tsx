import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './styles/tokens.css';
import './styles/base.css';
import { App } from './App';
import { AuthProvider } from './app/AuthContext';
import { ToastProvider } from './design';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root is missing from index.html');

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
