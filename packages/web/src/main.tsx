import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App';
import { AppApolloProvider } from './lib/apollo';
import './styles/app.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <AppApolloProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AppApolloProvider>
  </React.StrictMode>,
);
