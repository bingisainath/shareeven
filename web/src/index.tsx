import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from './redux/store';
import App from '../src/app/App';
// Fonts are bundled and served from our own site: no request to Google (it would see every visitor's IP)
import '@fontsource-variable/dm-sans/opsz.css';
import '@fontsource-variable/manrope';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      {/* <BrowserRouter> */}
        <App />
        
      {/* </BrowserRouter> */}
    </Provider>
  </React.StrictMode>
);