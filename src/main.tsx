import ReactDOM from 'react-dom/client';
import { AuthWrapper } from './app/AuthWrapper';
import { AnalyticsInitializer } from './utils/analytics';
import { registerPWA } from './utils/pwa-utils';
import './styles/index.scss';

// Set the app client_id once at boot so both getAppId() (WebSocket)
// and getServerInfo() (OIDC/OAuth2) always read the correct value.
// This overrides the numeric fallback IDs in config.ts.
const APP_CLIENT_ID = '335G35zPoJOjUXJkl0LlQ';
if (!localStorage.getItem('config.app_id')) {
    localStorage.setItem('config.app_id', APP_CLIENT_ID);
}

AnalyticsInitializer();
registerPWA()
    .then(registration => {
        if (registration) {
            console.log('PWA service worker registered successfully for Chrome');
        } else {
            console.log('PWA service worker disabled for non-Chrome browser');
        }
    })
    .catch(error => {
        console.error('PWA service worker registration failed:', error);
    });

ReactDOM.createRoot(document.getElementById('root')!).render(<AuthWrapper />);
